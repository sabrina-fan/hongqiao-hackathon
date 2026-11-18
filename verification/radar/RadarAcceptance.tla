-------------------------- MODULE RadarAcceptance --------------------------
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS RemoveByStopId, None, Committed, Conflict, Rejected
VARIABLES clock, active, trips, offers, ledger, acceptances
vars == <<clock, active, trips, offers, ledger, acceptances>>

Sessions == {"s1", "s2"}
Keys == {"k1", "k2"}
TripIds == {"original", "later"}
Poi == "same-place"
LastTick == 5
TTL == 2
LockStart == 2
LockEnd == 4
EmptyTrip(rev) == [rev |-> rev, stops |-> <<>>, edited |-> FALSE]

Init ==
    /\ clock = 0
    /\ active = "original"
    /\ trips = [t \in TripIds |-> EmptyTrip(IF t = active THEN 1 ELSE 0)]
    /\ offers = [s \in Sessions |-> None]
    /\ ledger = [k \in Keys |-> None]
    /\ acceptances = [s \in Sessions |-> None]

Running(t, at) == t = "original" /\ LockStart <= at /\ at < LockEnd

\* The offer stands for the outcome and its atomically published validated binding.
Binding(s, epoch) ==
    [session |-> s, proposal |-> epoch, proposalRev |-> epoch,
     poolRev |-> 1, etaRev |-> epoch, trip |-> active, tripRev |-> trips[active].rev]
Offer(s, epoch, slack) ==
    [binding |-> Binding(s, epoch), fetched |-> clock, latest |-> clock + slack]

Tick ==
    /\ clock < LastTick
    /\ clock' = clock + 1
    /\ UNCHANGED <<active, trips, offers, ledger, acceptances>>

CreateLaterTrip ==
    /\ active = "original"
    /\ active' = "later"
    /\ trips' = [trips EXCEPT !["later"] = EmptyTrip(1)]
    /\ UNCHANGED <<clock, offers, ledger, acceptances>>

EditTrip(t) ==
    /\ trips[t].rev > 0
    /\ ~trips[t].edited
    /\ trips' = [trips EXCEPT ![t].edited = TRUE, ![t].rev = @ + 1]
    /\ UNCHANGED <<clock, active, offers, ledger, acceptances>>

Publish(s, slack) ==
    /\ offers[s] = None
    /\ ~Running(active, clock)
    /\ offers' = [offers EXCEPT ![s] = Offer(s, 1, slack)]
    /\ UNCHANGED <<clock, active, trips, ledger, acceptances>>

Refresh(s) ==
    /\ offers[s] # None
    /\ offers[s].binding = Binding(s, 1)
    /\ ~Running(active, clock)
    /\ clock <= offers[s].latest
    /\ offers' = [offers EXCEPT ![s] = Offer(s, 2, @.latest - clock)]
    /\ UNCHANGED <<clock, active, trips, ledger, acceptances>>

Request(s, binding, poi) == [session |-> s, binding |-> binding, poi |-> poi]
WrongField(binding, field) ==
    [binding EXCEPT ![field] = IF field \in {"session", "trip"} THEN "other" ELSE @ + 1]

Requests(s) ==
    IF offers[s] = None THEN {}
    ELSE LET b == offers[s].binding
             earlier == [b EXCEPT !.proposal = 1, !.proposalRev = 1, !.etaRev = 1]
         IN {Request(s, b, Poi), Request(s, b, "other-place"), Request(s, earlier, Poi)}
            \cup {Request(s, WrongField(b, field), Poi) : field \in DOMAIN b}

FreshUntil(offer) ==
    IF offer.fetched + TTL < offer.latest + 1 THEN offer.fetched + TTL ELSE offer.latest + 1

CanConfirm(request) ==
    LET s == request.session
        offer == offers[s]
    IN /\ offer # None
       /\ request.binding = offer.binding
       /\ offer.binding = Binding(s, offer.binding.proposalRev)
       /\ request.poi = Poi
       /\ offer.fetched <= clock /\ clock < FreshUntil(offer)
       /\ ~Running(active, clock)

CommitConfirmation(k, request) ==
    LET s == request.session
        trip == trips[active]
        receipt == [trip |-> active, rev |-> trip.rev + 1, stop |-> s]
    IN /\ trips' = [trips EXCEPT ![active].rev = receipt.rev, ![active].stops = Append(@, s)]
       /\ ledger' = [ledger EXCEPT ![k] = [request |-> request, receipt |-> receipt]]
       /\ acceptances' = [acceptances EXCEPT ![s] = [receipt |-> receipt, undone |-> FALSE]]
       /\ UNCHANGED <<clock, active, offers>>

\* result is an observable return value, not persisted state. Responses can be lost.
Confirm(k, request, result) ==
    IF ledger[k] # None
    THEN /\ result = IF request = ledger[k].request THEN ledger[k].receipt ELSE Conflict
         /\ UNCHANGED vars
    ELSE IF CanConfirm(request)
         THEN /\ result = Committed
              /\ CommitConfirmation(k, request)
         ELSE /\ result = Rejected
              /\ UNCHANGED vars

RemoveStop(stops, stop) == SelectSeq(stops, LAMBDA id: id # stop)

Undo(s, stop) ==
    LET entry == acceptances[s]
    IN IF entry = None THEN UNCHANGED vars
       ELSE IF entry.receipt.stop # stop \/ entry.undone THEN UNCHANGED vars
       ELSE LET t == entry.receipt.trip
                remaining == IF RemoveByStopId THEN RemoveStop(trips[t].stops, stop) ELSE <<>>
            IN /\ trips' = [trips EXCEPT ![t].stops = remaining, ![t].rev = @ + 1]
               /\ acceptances' = [acceptances EXCEPT ![s].undone = TRUE]
               /\ UNCHANGED <<clock, active, offers, ledger>>

Next ==
    \/ Tick
    \/ CreateLaterTrip
    \/ \E t \in TripIds : EditTrip(t)
    \/ \E s \in Sessions : Publish(s, 0) \/ Publish(s, 3) \/ Refresh(s)
    \/ \E k \in Keys, s \in Sessions : \E request \in Requests(s) :
           LET replay == IF ledger[k] = None THEN Rejected ELSE ledger[k].receipt
           IN \E result \in {Committed, Conflict, Rejected, replay} :
                  Confirm(k, request, result)
    \/ \E s \in Sessions, stop \in Sessions : Undo(s, stop)

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ clock \in 0..LastTick
    /\ active \in TripIds
    /\ \A t \in TripIds :
           /\ trips[t].rev \in 0..6
           /\ Len(trips[t].stops) \in 0..2
           /\ \A i \in DOMAIN trips[t].stops : trips[t].stops[i] \in Sessions
           /\ trips[t].edited \in BOOLEAN

LiveStopsMatchReceipts ==
    /\ \A t \in TripIds :
           LET ids == {trips[t].stops[i] : i \in DOMAIN trips[t].stops}
           IN /\ Len(trips[t].stops) = Cardinality(ids)
              /\ ids = {s \in Sessions :
                            IF acceptances[s] = None THEN FALSE
                            ELSE ~acceptances[s].undone /\ acceptances[s].receipt.trip = t}
    /\ \A s \in Sessions :
           LET keys == {k \in Keys : IF ledger[k] = None THEN FALSE ELSE ledger[k].receipt.stop = s}
           IN IF acceptances[s] = None THEN keys = {}
              ELSE /\ Cardinality(keys) = 1
                   /\ \A k \in keys : ledger[k].receipt = acceptances[s].receipt

HistoricalReplay ==
    \A k \in Keys : ledger[k] # None =>
        LET entry == ledger[k]
            changed == [entry.request EXCEPT !.poi = "other-place"]
        IN /\ ENABLED Confirm(k, entry.request, entry.receipt)
           /\ ENABLED Confirm(k, changed, Conflict)
           /\ ~ENABLED Confirm(k, changed, entry.receipt)
           /\ ~ENABLED Confirm(k, entry.request, Conflict)

AuthorizedAndAtomicStep ==
    \A k \in Keys :
        IF ledger[k] # None THEN ledger'[k] = ledger[k]
        ELSE ledger'[k] # None =>
            LET entry == ledger'[k]
                request == entry.request
                s == request.session
                offer == offers[s]
                receipt == entry.receipt
            IN /\ offer # None
               /\ request.binding = offer.binding /\ request.poi = Poi
               /\ request.binding.session = s /\ request.binding.trip = active
               /\ request.binding.tripRev = trips[active].rev
               /\ clock \in offer.fetched..(offer.fetched + TTL - 1)
               /\ clock <= offer.latest
               /\ ~(active = "original" /\ clock \in LockStart..(LockEnd - 1))
               /\ receipt = [trip |-> active, rev |-> trips[active].rev + 1, stop |-> s]
               /\ trips' = [trips EXCEPT ![active].rev = receipt.rev, ![active].stops = Append(@, s)]
               /\ acceptances' = [acceptances EXCEPT ![s] = [receipt |-> receipt, undone |-> FALSE]]

DirectedUndoStep ==
    \A s \in Sessions :
        acceptances[s] # None /\ acceptances'[s] # acceptances[s] =>
            LET r == acceptances[s].receipt
            IN /\ ~acceptances[s].undone
               /\ acceptances' = [acceptances EXCEPT ![s].undone = TRUE]
               /\ trips' = [trips EXCEPT ![r.trip].stops = RemoveStop(@, r.stop), ![r.trip].rev = @ + 1]
               /\ UNCHANGED <<clock, active, offers, ledger>>

AuthorizedAndAtomic == [][AuthorizedAndAtomicStep]_vars
DirectedUndo == [][DirectedUndoStep]_vars
=============================================================================
