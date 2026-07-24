package fcewire

import (
	"context"
	"log"
	"math/big"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"

	"wd-matcher"
)

// Snapshotter is what handler.go depends on to build a matcher.ChainSnapshot at RFQ_MATCH time —
// an interface so tests can substitute a fake with no live chain connection (see handler_test.go).
type Snapshotter interface {
	// TrackTaker/TrackMaker register an address for the background cache to keep warm. Idempotent.
	TrackTaker(addr common.Address)
	TrackMaker(addr common.Address)

	// Snapshot builds a matcher.ChainSnapshot from ONLY cached values — never performs a live RPC
	// call. This is the hard invariant docs/design.md §4.1 imposes: the proxy's POST /action call
	// has a 2-second client timeout, so no handler path may block on chain I/O.
	Snapshot(taker common.Address, makers []common.Address, now time.Time) matcher.ChainSnapshot
}

// ChainCache is the production Snapshotter: a background goroutine polls FTSOv2 (every
// PriceRefreshSec) and every tracked address's BondLedger/DvPEscrow balance (every tick too — desk
// scale, a handful of addresses, no batching needed for a hackathon demo instance), caching results
// under a mutex. All reads are cached-never-in-path per docs/design.md §4.4.
type ChainCache struct {
	client *ethclient.Client
	cfg    Config

	ftsoV2Addr common.Address // resolved once at boot via the registry

	mu            sync.RWMutex
	midE18        *big.Int
	midFetchAt    time.Time
	bondFree      map[common.Address]uint64
	takerAvail    map[common.Address]uint64
	trackedMakers map[common.Address]struct{}
	trackedTakers map[common.Address]struct{}
}

// NewChainCache dials CHAIN_URL and resolves FtsoV2's address via WD_REGISTRY_ADDR. Call Run in its
// own goroutine to start the background poll loop.
func NewChainCache(ctx context.Context, cfg Config) (*ChainCache, error) {
	client, err := ethclient.DialContext(ctx, cfg.ChainURL)
	if err != nil {
		return nil, err
	}

	ftsoV2Addr, err := resolveContractAddress(ctx, client, cfg.RegistryAddr, "FtsoV2")
	if err != nil {
		client.Close()
		return nil, err
	}

	return &ChainCache{
		client:        client,
		cfg:           cfg,
		ftsoV2Addr:    ftsoV2Addr,
		bondFree:      make(map[common.Address]uint64),
		takerAvail:    make(map[common.Address]uint64),
		trackedMakers: make(map[common.Address]struct{}),
		trackedTakers: make(map[common.Address]struct{}),
	}, nil
}

func (c *ChainCache) TrackMaker(addr common.Address) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.trackedMakers[addr] = struct{}{}
}

func (c *ChainCache) TrackTaker(addr common.Address) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.trackedTakers[addr] = struct{}{}
}

// Run blocks, refreshing the cache every PriceRefreshSec until ctx is cancelled. Errors are logged
// and never fatal — a failed refresh just leaves the previous (possibly now-stale) cache in place,
// and matchCore fails closed (WD_ERR_PRICE_STALE / INSUFFICIENT_* reasons) on stale/missing data.
func (c *ChainCache) Run(ctx context.Context) {
	interval := time.Duration(c.cfg.PriceRefreshSec) * time.Second
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	c.refresh(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.refresh(ctx)
		}
	}
}

func (c *ChainCache) refresh(ctx context.Context) {
	rctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	value, ts, err := getFeedByIdInWei(rctx, c.client, c.ftsoV2Addr, XrpUsdFeedID)
	if err != nil {
		log.Printf("fcewire: ChainCache: FTSOv2 refresh failed: %v", err)
	} else {
		c.mu.Lock()
		c.midE18 = value
		_ = ts
		c.midFetchAt = time.Now()
		c.mu.Unlock()
	}

	c.mu.RLock()
	makers := make([]common.Address, 0, len(c.trackedMakers))
	for m := range c.trackedMakers {
		makers = append(makers, m)
	}
	takers := make([]common.Address, 0, len(c.trackedTakers))
	for t := range c.trackedTakers {
		takers = append(takers, t)
	}
	c.mu.RUnlock()

	for _, m := range makers {
		amount, err := freeBond(rctx, c.client, c.cfg.BondAddr, m)
		if err != nil {
			log.Printf("fcewire: ChainCache: freeBond(%s) refresh failed: %v", m.Hex(), err)
			continue
		}
		c.mu.Lock()
		c.bondFree[m] = amount
		c.mu.Unlock()
	}

	for _, t := range takers {
		armed, committed, armedUntil, err := takerBalance(rctx, c.client, c.cfg.EscrowAddr, t)
		if err != nil {
			log.Printf("fcewire: ChainCache: balances(%s) refresh failed: %v", t.Hex(), err)
			continue
		}
		available := uint64(0)
		if armed > committed && uint64(time.Now().Unix()) <= armedUntil {
			available = armed - committed
		}
		c.mu.Lock()
		c.takerAvail[t] = available
		c.mu.Unlock()
	}
}

// Snapshot builds a matcher.ChainSnapshot purely from the cache — no RPC call on this path.
func (c *ChainCache) Snapshot(taker common.Address, makers []common.Address, now time.Time) matcher.ChainSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()

	bonds := make(map[common.Address]uint64, len(makers))
	for _, m := range makers {
		bonds[m] = c.bondFree[m] // zero-value default if never fetched — fails closed
	}

	var midAge time.Duration
	if c.midFetchAt.IsZero() {
		midAge = time.Duration(c.cfg.PriceStaleMaxSec+1) * time.Second // force stale if never fetched
	} else {
		midAge = now.Sub(c.midFetchAt)
	}

	return matcher.ChainSnapshot{
		MidE18:            c.midE18,
		MidAge:            midAge,
		FreeBondRaw:       bonds,
		TakerAvailableRaw: c.takerAvail[taker], // zero-value default if never fetched — fails closed
	}
}

// Close releases the underlying RPC client.
func (c *ChainCache) Close() {
	c.client.Close()
}
