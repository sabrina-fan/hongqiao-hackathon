------------------------- MODULE ImageCleanupRetry -------------------------
EXTENDS Naturals, FiniteSets, Sequences

CONSTANT DropRegistration

MaxNewDeletions == 2

Owner == "owner"
OtherGuest == "otherGuest"
Guests == {Owner, OtherGuest}
Trips == {"tripA", "tripB"}
NoTrip == "none"
ImageOrder == <<"single", "shared", "other", "pending">>
Images == {ImageOrder[i] : i \in DOMAIN ImageOrder}
InitialImports == {"single", "shared", "other"}
InitialBatch == {"pending"}
InitialWishlist == {"shared"}
InitialReceipts == {<<"shared", "shared">>, <<"other", "shared">>, <<"other", "other">>}
InitialOwner == [id \in Images |-> IF id = "other" THEN "tripB" ELSE "tripA"]
Copies == {"original", "normalized"}
Entries == Copies \cup {"directory"}
DiskEntries(ids) == ids \X Entries
Ordered(ids) == SelectSeq(ImageOrder, LAMBDA id : id \in ids)

\* A single batch ID is implicit. Revisions only affect the batch replay key.
Request(guest, kind, id, rev) == [guest |-> guest, kind |-> kind, id |-> id, rev |-> rev]
Revisions == 0..2
PrivacyRequests == {Request(g, "source", i, 0) : g \in Guests, i \in Images}
                   \cup {Request(g, "trip", t, 0) : g \in Guests, t \in Trips}
BatchRequests == {Request(Owner, "batch", "pending", rev) : rev \in Revisions}
Requests == PrivacyRequests \cup BatchRequests
OwnedRequests == {r \in Requests : r.guest = Owner}
NoRequest == Request(Owner, "none", "none", 0)

VARIABLES db, records, disk, job, healthy, ledger
vars == <<db, records, disk, job, healthy, ledger>>

NoRecord == [status |-> "absent", ids |-> <<>>]
NoEntry == [status |-> "absent", ids |-> {}]
Idle == {"idle", "ok", "missingBatch"}
Active == {"transaction", "load", "cleanup", "reply"}
Job(phase, r, replay) == [phase |-> phase, request |-> r, replay |-> replay, todo |-> <<>>]

Init ==
    /\ db = [trips |-> Trips, batchLive |-> TRUE, batchOwner |-> "tripA",
             batchItems |-> InitialBatch, rev |-> 0, imports |-> InitialImports,
             importOwner |-> InitialOwner, wishlist |-> InitialWishlist,
             receipts |-> InitialReceipts]
    /\ records = [r \in Requests |-> NoRecord]
    /\ disk = DiskEntries(Images)
    /\ job = Job("idle", NoRequest, FALSE)
    /\ healthy = FALSE
    /\ ledger = [r \in Requests |-> NoEntry]

Inventory(d) == d.batchItems \cup d.imports
InventoryOwner(d, id) == IF id \in d.batchItems THEN d.batchOwner ELSE d.importOwner[id]
References(d) == Inventory(d) \cup d.wishlist \cup {link[2] : link \in d.receipts}

CanRegister(r) ==
    /\ r.guest = Owner
    /\ CASE r.kind = "trip" -> r.id \in db.trips
         [] r.kind = "source" -> r.id \in Inventory(db)
         [] r.kind = "batch" -> db.batchLive /\ r.rev = db.rev /\ r.id \in db.batchItems

Plan(d, r) ==
    IF r.kind = "trip"
    THEN {id \in Inventory(d) : InventoryOwner(d, id) = r.id /\ id \notin d.wishlist}
    ELSE {r.id}

ApplyDeletion(d, r, ids) ==
    LET trip == IF r.kind = "trip" THEN {r.id} ELSE {}
        items == d.batchItems \ ids
        batchChanged == items # d.batchItems \/ d.batchOwner \in trip
        batchRetired == r.kind # "batch" /\ batchChanged /\ items = {}
    IN [d EXCEPT
        !.trips = @ \ trip,
        !.batchLive = @ /\ ~batchRetired,
        !.batchOwner = IF batchRetired \/ @ \in trip THEN NoTrip ELSE @,
        !.batchItems = items,
        !.rev = IF batchChanged /\ ~batchRetired THEN @ + 1 ELSE @,
        !.imports = @ \ ids,
        !.importOwner = [id \in Images |->
            IF d.importOwner[id] \in trip THEN NoTrip ELSE d.importOwner[id]],
        !.wishlist = IF r.kind = "source" THEN @ \ ids ELSE @,
        !.receipts = {link \in @ : {link[1], link[2]} \cap ids = {}}]

Committed == {r \in Requests : ledger[r].status # "absent"}

Submit(r) ==
    /\ job.phase \in Idle
    /\ CASE records[r].status = "pending" -> job' = Job("load", r, TRUE)
         [] records[r].status = "done" -> job' = Job("reply", r, FALSE)
         [] CanRegister(r) -> /\ Cardinality(Committed) < MaxNewDeletions
                              /\ job' = Job("transaction", r, FALSE)
         [] r.kind # "batch" -> UNCHANGED job \* Idempotent 204 for absent target.
         [] OTHER -> FALSE \* Rejected batch identity/revision, no cleanup.
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

\* Observer history uses a separate derivation from the pre-commit references.
ExpectedTargets(d, r) ==
    IF r.kind = "trip"
    THEN LET batch == IF d.batchOwner = r.id THEN d.batchItems ELSE {}
             singles == {id \in d.imports \ d.batchItems : d.importOwner[id] = r.id}
         IN (batch \cup singles) \ d.wishlist
    ELSE {r.id}

Commit ==
    /\ job.phase = "transaction"
    /\ LET r == job.request
           ids == Plan(db, r)
       IN /\ db' = ApplyDeletion(db, r, ids)
          /\ records' = IF DropRegistration THEN records ELSE
                        [records EXCEPT ![r] = [status |-> "pending", ids |-> Ordered(ids)]]
          /\ ledger' = [ledger EXCEPT ![r] = [status |-> "pending", ids |-> ExpectedTargets(db, r)]]
          /\ job' = Job("load", r, FALSE)
    /\ UNCHANGED <<disk, healthy>>

Load ==
    /\ job.phase = "load"
    /\ records[job.request].status = "pending"
    /\ job' = [job EXCEPT !.phase = "cleanup", !.todo = records[job.request].ids]
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

Unlink(entry) ==
    /\ job.phase = "cleanup"
    /\ job.todo # <<>>
    /\ LET id == Head(job.todo) IN
       /\ <<id, entry>> \in disk
       /\ entry = "directory" => disk \cap ({id} \X Copies) = {}
       /\ disk' = disk \ {<<id, entry>>}
    /\ UNCHANGED <<db, records, job, healthy, ledger>>

DirectoryDone ==
    /\ job.phase = "cleanup"
    /\ job.todo # <<>>
    /\ disk \cap DiskEntries({Head(job.todo)}) = {}
    /\ job' = [job EXCEPT !.todo = Tail(@)]
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

\* The second commit acknowledges only after all rm calls return successfully.
Ack ==
    /\ job.phase = "cleanup"
    /\ job.todo = <<>>
    /\ LET r == job.request IN
       /\ records' = [records EXCEPT ![r] = IF r.kind = "batch"
                      THEN [status |-> "done", ids |-> <<>>] ELSE NoRecord]
       /\ ledger' = [ledger EXCEPT ![r].status = "acked"]
    /\ job' = [job EXCEPT !.phase = "reply"]
    /\ UNCHANGED <<db, disk, healthy>>

Reply ==
    /\ job.phase = "reply"
    /\ job' = [job EXCEPT !.phase = IF job.request.kind = "batch" /\ ~db.batchLive
                                   THEN "missingBatch" ELSE "ok"]
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

\* Fail can abort the first commit, interrupt rm, abort Ack, or lose the reply.
\* Crash discards all volatile progress. Neither failure writes a new cursor.
Fail ==
    /\ ~healthy /\ job.phase \in Active
    /\ job' = Job("idle", NoRequest, FALSE)
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

Crash ==
    /\ ~healthy /\ job.phase \in Active
    /\ job' = Job("down", NoRequest, FALSE)
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

Restart ==
    /\ job.phase = "down"
    /\ job' = Job("idle", NoRequest, FALSE)
    /\ UNCHANGED <<db, records, disk, healthy, ledger>>

Repair ==
    /\ ~healthy /\ job.phase \in Idle \cup {"down"}
    /\ healthy' = TRUE
    /\ job' = IF job.phase = "down" THEN job ELSE Job("idle", NoRequest, FALSE)
    /\ UNCHANGED <<db, records, disk, ledger>>

Progress == Commit \/ Load \/ (\E entry \in Entries : Unlink(entry))
            \/ DirectoryDone \/ Ack \/ Reply \/ Fail \/ Crash
Next == (\E r \in Requests : Submit(r)) \/ Progress \/ Restart \/ Repair
Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)

TypeOK ==
    /\ db \in [trips : SUBSET Trips, batchLive : BOOLEAN, batchOwner : Trips \cup {NoTrip},
                batchItems : SUBSET Images, rev : Revisions, imports : SUBSET Images,
                importOwner : [Images -> Trips \cup {NoTrip}], wishlist : SUBSET Images,
                receipts : SUBSET (Images \X Images)]
    /\ records \in [Requests -> [status : {"absent", "pending", "done"}, ids : Seq(Images)]]
    /\ ledger \in [Requests -> [status : {"absent", "pending", "acked"}, ids : SUBSET Images]]
    /\ disk \subseteq DiskEntries(Images)
    /\ job \in [phase : Idle \cup Active \cup {"down"}, request : Requests \cup {NoRequest},
                 replay : BOOLEAN, todo : Seq(Images)]
    /\ healthy \in BOOLEAN

Registered == {r \in Requests : ledger[r].status = "pending"}
Removed == UNION {ledger[r].ids : r \in Committed}

AtomicRegistration ==
    /\ \A r \in Requests :
       records[r] = CASE r \in Registered -> [status |-> "pending", ids |-> Ordered(ledger[r].ids)]
                       [] r \in Committed /\ r.kind = "batch" -> [status |-> "done", ids |-> <<>>]
                       [] OTHER -> NoRecord
    /\ db.trips = Trips \ {r.id : r \in {q \in Committed : q.kind = "trip"}}
    /\ db.batchItems = InitialBatch \ Removed
    /\ db.imports = InitialImports \ Removed

PreservedReferences ==
    /\ DiskEntries(References(db)) \subseteq disk
    /\ disk \cup DiskEntries(Removed) = DiskEntries(Images)
    /\ db.wishlist = InitialWishlist \ Removed
    /\ db.receipts = {link \in InitialReceipts : {link[1], link[2]} \cap Removed = {}}
    /\ \A id \in Inventory(db) :
       InventoryOwner(db, id) = IF InitialOwner[id] \in db.trips THEN InitialOwner[id] ELSE NoTrip

\* A freshly served settings read after queue admission, with no UI cache.
Settings(guest) == {<<r.kind, r.id>> : r \in
    {q \in PrivacyRequests : q.guest = guest /\ records[q].status = "pending"}}
SettingsDiscovery ==
    /\ Settings(Owner) = {<<r.kind, r.id>> : r \in (Registered \cap PrivacyRequests)}
    /\ Settings(OtherGuest) = {}

ExactResume ==
    job.phase = "cleanup" =>
      LET ids == Ordered(ledger[job.request].ids)
          done == Len(ids) - Len(job.todo)
      IN /\ job.request \in Registered
         /\ \E n \in 0..Len(ids) :
              /\ Len(job.todo) = Len(ids) - n
              /\ \A i \in DOMAIN job.todo : job.todo[i] = ids[n + i]
         /\ \A i \in DOMAIN ids : i <= done => disk \cap DiskEntries({ids[i]}) = {}

LoadRestartsFromBeginning == [] [
    (job.phase = "load" /\ job'.phase = "cleanup") =>
        job'.todo = Ordered(ledger[job.request].ids)]_vars

AckAndReplySound ==
    /\ \A r \in (Committed \ Registered) : disk \cap DiskEntries(ledger[r].ids) = {}
    /\ job.phase = "ok" => job.request \in (Committed \ Registered)

HealthyReplay(r) == healthy /\ job.phase = "load" /\ job.replay /\ job.request = r
HealthyReplayCleans == \A r \in OwnedRequests : HealthyReplay(r) ~> (ledger[r].status = "acked")
Confirmed(r) == job.phase = "ok" /\ job.request = r
HealthyReplayConfirms == \A r \in OwnedRequests :
    (HealthyReplay(r) /\ (r.kind # "batch" \/ db.batchLive)) ~> Confirmed(r)

\* Diagnostic checks enabled by separate configs.
NoRetryStillCleans == \A r \in OwnedRequests :
    (healthy /\ job.phase = "idle" /\ r \in Registered) ~> (ledger[r].status = "acked")
RetiredBatchReplayConfirms == ~(healthy /\ job.replay /\ job.phase = "missingBatch")
=============================================================================
