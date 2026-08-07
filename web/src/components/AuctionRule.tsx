/* ---------------------------------------------------------------------------
   AuctionRule — how the fill gets decided, stated where both seats can see it.

   Every other RFQ venue shows the taker a list of quotes and lets them pick.
   This one does not, and that reads as a missing feature until you say why:
   because the rule runs inside the enclave, nobody can steer it. Not the desk
   operating the venue, not the taker who authored the order, not a maker with
   a relationship to lean on. Best price wins because a deterministic function
   said so, and it said so somewhere no one can reach.

   The second half matters just as much. A quote that clears every filter and
   simply loses on price is counted nowhere — not in the match response, not in
   the aggregate reasons map, nowhere. Losing costs a maker nothing, not even
   the disclosure that they were there. That is the property a pick-your-quote
   venue cannot offer, because showing the taker a list is showing them
   everyone who lost.

   Static by design: this states the matching rule in extension/matcher/match.go,
   it does not report on a run. Wiring it to a live figure would invite the one
   thing it must never carry — a count of who else is quoting.
--------------------------------------------------------------------------- */

export default function AuctionRule() {
  return (
    <div className="panel overflow-hidden">
      <div className="px-5 py-3.5 border-b border-steel-line">
        <p className="mono-label text-[0.6rem] text-ice">How the fill is decided</p>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="flex items-baseline gap-2.5">
          <span className="mono-label text-[0.5rem] text-ink-3 shrink-0 w-16">rule</span>
          <p className="mono-label text-[0.56rem] text-ink leading-relaxed">
            Best price wins. Ties break by arrival order.
          </p>
        </div>
        <div className="flex items-baseline gap-2.5">
          <span className="mono-label text-[0.5rem] text-ink-3 shrink-0 w-16">where</span>
          <p className="mono-label text-[0.56rem] text-ink leading-relaxed">
            Inside the enclave, over sealed quotes.
          </p>
        </div>
        <div className="flex items-baseline gap-2.5">
          <span className="mono-label text-[0.5rem] text-ink-3 shrink-0 w-16">who picks</span>
          <p className="mono-label text-[0.56rem] text-ink leading-relaxed">
            Nobody. Not the desk, not the taker.
          </p>
        </div>
      </div>

      <div className="px-5 py-3 border-t border-steel-line bg-vault-2/60">
        {/* One line, not five. The rail has to clear the fold alongside two other panels, and the
            long form of this argument lives in the docs where there is room for it. */}
        <p className="mono-label text-[0.5rem] text-ink-3 leading-snug">
          A losing quote is <span className="text-ink">recorded nowhere</span> — not even that it
          existed. Venues that let the taker pick must disclose every loser.
        </p>
      </div>
    </div>
  );
}
