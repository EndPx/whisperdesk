package fcewire

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// EIP-712 domain + type for the maker Quote signature (docs/design.md §6.2): quotes never touch the
// chain, so this is a pure Go-side verification with no Solidity counterpart to stay byte-identical
// with — it only needs to match what wallets produce for a standard eth_signTypedData_v4 call over
// this domain/type, which is what MetaMask/viem/ethers all implement identically (EIP-712 is fully
// standardized, unlike the WD_MATCH_V1 application-level scheme in extension/matcher/instruction.go).
//
//	domain: {name:"WhisperDesk", version:"1", chainId:114, verifyingContract:<WD_ESCROW_ADDR>}
//	type:   Quote(bytes32 rfqId,address maker,uint256 priceUsdE18,uint256 maxFxrpRaw,uint256 nonce)
var (
	eip712DomainTypeHash = crypto.Keccak256([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	quoteTypeHash        = crypto.Keccak256([]byte("Quote(bytes32 rfqId,address maker,uint256 priceUsdE18,uint256 maxFxrpRaw,uint256 nonce)"))
	domainNameHash       = crypto.Keccak256([]byte("WhisperDesk"))
	domainVersionHash    = crypto.Keccak256([]byte("1"))
)

func quoteDomainSeparator(chainID uint64, verifyingContract common.Address) common.Hash {
	buf := make([]byte, 0, 32*5)
	buf = append(buf, eip712DomainTypeHash...)
	buf = append(buf, domainNameHash...)
	buf = append(buf, domainVersionHash...)
	buf = append(buf, common.LeftPadBytes(new(big.Int).SetUint64(chainID).Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(verifyingContract.Bytes(), 32)...)
	return crypto.Keccak256Hash(buf)
}

func quoteStructHash(rfqID common.Hash, maker common.Address, priceUsdE18, maxFxrpRaw, nonce *big.Int) common.Hash {
	buf := make([]byte, 0, 32*6)
	buf = append(buf, quoteTypeHash...)
	buf = append(buf, rfqID[:]...)
	buf = append(buf, common.LeftPadBytes(maker.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(priceUsdE18.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(maxFxrpRaw.Bytes(), 32)...)
	buf = append(buf, common.LeftPadBytes(nonce.Bytes(), 32)...)
	return crypto.Keccak256Hash(buf)
}

// QuoteDigest computes the EIP-712 digest ("\x19\x01" || domainSeparator || structHash) a maker's
// wallet signs over via eth_signTypedData_v4.
func QuoteDigest(chainID uint64, verifyingContract common.Address, rfqID common.Hash, maker common.Address,
	priceUsdE18, maxFxrpRaw, nonce *big.Int,
) common.Hash {
	ds := quoteDomainSeparator(chainID, verifyingContract)
	sh := quoteStructHash(rfqID, maker, priceUsdE18, maxFxrpRaw, nonce)

	buf := make([]byte, 0, 2+32+32)
	buf = append(buf, 0x19, 0x01)
	buf = append(buf, ds[:]...)
	buf = append(buf, sh[:]...)
	return crypto.Keccak256Hash(buf)
}

// VerifyQuoteSignature recovers the signer from a 65-byte [R||S||V] signature (V in {27,28}, the
// standard wallet output) over the EIP-712 Quote digest and requires it equal maker. This is the
// maker-quote authentication the matcher package's UpsertQuote deliberately does NOT perform itself
// (book.go: "Caller (the /direct handler) is responsible for the EIP-712 signature + bond checks —
// this method only owns book bookkeeping and nonce monotonicity") — handler.go calls this before
// ever touching the book.
func VerifyQuoteSignature(chainID uint64, verifyingContract common.Address, rfqID common.Hash, maker common.Address,
	priceUsdE18, maxFxrpRaw, nonce *big.Int, sig []byte,
) error {
	if len(sig) != 65 {
		return fmt.Errorf("fcewire: quote signature must be 65 bytes, got %d", len(sig))
	}

	digest := QuoteDigest(chainID, verifyingContract, rfqID, maker, priceUsdE18, maxFxrpRaw, nonce)

	normalized := append([]byte(nil), sig...)
	if normalized[64] >= 27 {
		normalized[64] -= 27
	}

	pub, err := crypto.SigToPub(digest[:], normalized)
	if err != nil {
		return fmt.Errorf("fcewire: recovering quote signer: %w", err)
	}
	recovered := crypto.PubkeyToAddress(*pub)
	if recovered != maker {
		return fmt.Errorf("fcewire: quote signature signer %s does not match claimed maker %s", recovered.Hex(), maker.Hex())
	}
	return nil
}
