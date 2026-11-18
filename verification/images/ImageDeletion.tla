--------------------------- MODULE ImageDeletion ---------------------------
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS MaxRequests, DeleteBeforeCommit

NoOwner == "none"
Trips == {"tripA", "tripB"}
ImageOrder == <<"pending1", "pending2", "saved", "single", "other">>
Images == {ImageOrder[i] : i \in DOMAIN ImageOrder}
Copies == {"original", "normalized"}
AllFiles == Images \X Copies
CopyFiles(ids) == ids \X Copies

Request(kind, target) == [kind |-> kind, target |-> target]
NoRequest == Request("none", "none")
Requests == {Request("batch", id) : id \in Images}
         \cup {Request("source", id) : id \in Images}
         \cup {Request("trip", id) : id \in Trips}
IdlePhases == {"idle", "aborted", "succeeded", "failed", "interrupted"}
WorkPhases == {"transaction", "cleanup"}

VARIABLES db, files, job, attempts, faults
vars == <<db, files, job, attempts, faults>>

References(d) == d.items \cup d.imports \cup d.sources
                 \cup {link[2] : link \in d.receiptLinks}
Orphans == files \ CopyFiles(References(db))

Init ==
    /\ \E sources \in {{"saved", "other"}, {}} :
        db = [trips |-> Trips,
              items |-> {"pending1", "pending2", "saved"},
              batchOwner |-> "tripA",
              imports |-> {"saved", "single", "other"},
              importOwner |-> [id \in Images |-> CASE id = "single" -> "tripA"
                                                   [] id = "other" -> "tripB"
                                                   [] OTHER -> NoOwner],
              sources |-> sources,
              receiptLinks |-> {<<"saved", "saved">>, <<"other", "saved">>,
                                 <<"other", "other">>}]
    /\ files = AllFiles
    /\ job = [request |-> NoRequest, phase |-> "idle", committed |-> FALSE,
              beforeDb |-> db, beforeFiles |-> files, targets |-> {}, todo |-> <<>>]
    /\ attempts = 0
    /\ faults = {}

\* Batch metadata overrides import metadata for the same ID in the inventory.
InventoryOwner(d, id) == IF id \in d.items THEN d.batchOwner ELSE d.importOwner[id]

CanStart(r) ==
    CASE r.kind = "batch" -> r.target \in db.items \ {"saved"}
      [] r.kind = "source" -> r.target \in (db.items \cup db.imports)
      [] r.kind = "trip" -> r.target \in db.trips

Plan(r) ==
    IF r.kind = "trip"
    THEN {id \in (db.items \cup db.imports) :
          InventoryOwner(db, id) = r.target /\ id \notin db.sources}
    ELSE {r.target}

Begin(r) ==
    /\ job.phase \in IdlePhases
    /\ attempts < MaxRequests
    /\ CanStart(r)
    /\ LET ids == Plan(r) IN
       job' = [request |-> r, phase |-> "transaction", committed |-> FALSE,
               beforeDb |-> db, beforeFiles |-> files, targets |-> ids,
               todo |-> SelectSeq(ImageOrder, LAMBDA id: id \in ids)]
    /\ attempts' = attempts + 1
    /\ UNCHANGED <<db, files, faults>>

ApplyDeletion(d, r, ids) ==
    LET batchItems == d.items \ ids
        ownerToUnlink == IF r.kind = "trip" THEN r.target ELSE NoOwner
    IN [d EXCEPT
        !.trips = @ \ {ownerToUnlink},
        !.items = batchItems,
        !.batchOwner = IF batchItems = {} \/ @ = ownerToUnlink THEN NoOwner ELSE @,
        !.imports = IF r.kind = "batch" THEN @ ELSE @ \ ids,
        !.importOwner = [id \in Images |->
            IF id \in ids \/ d.importOwner[id] = ownerToUnlink
            THEN NoOwner ELSE d.importOwner[id]],
        !.sources = IF r.kind = "source" THEN @ \ ids ELSE @,
        !.receiptLinks = IF r.kind = "batch" THEN @ ELSE
            {link \in @ : link[1] \notin ids /\ link[2] \notin ids}]

CanResolveTransaction ==
    /\ job.phase = "transaction"
    /\ ~DeleteBeforeCommit \/ job.todo = <<>>

Commit ==
    /\ CanResolveTransaction
    /\ db' = ApplyDeletion(db, job.request, job.targets)
    /\ job' = [job EXCEPT !.committed = TRUE, !.phase = "cleanup"]
    /\ UNCHANGED <<files, attempts, faults>>

Abort ==
    /\ CanResolveTransaction
    /\ job' = [job EXCEPT !.phase = "aborted"]
    /\ UNCHANGED <<db, files, attempts, faults>>

CanCleanDirectory ==
    /\ job.phase = "cleanup" \/ (DeleteBeforeCommit /\ job.phase = "transaction")
    /\ Len(job.todo) > 0

\* One recursive rm can partially succeed before failure or exit. No check of
\* current DB references is made by the file adapter.
Unlink(copy) ==
    /\ CanCleanDirectory
    /\ LET file == <<Head(job.todo), copy>> IN
       /\ file \in files
       /\ files' = files \ {file}
    /\ UNCHANGED <<db, job, attempts, faults>>

DirectoryDone ==
    /\ CanCleanDirectory
    /\ files \cap CopyFiles({Head(job.todo)}) = {}
    /\ job' = [job EXCEPT !.todo = Tail(@)]
    /\ UNCHANGED <<db, files, attempts, faults>>

CleanupFails ==
    /\ CanCleanDirectory
    /\ job' = [job EXCEPT !.phase = "failed"]
    /\ faults' = faults \cup {"cleanup"}
    /\ UNCHANGED <<db, files, attempts>>

Finish ==
    /\ job.phase = "cleanup"
    /\ job.todo = <<>>
    /\ job' = [job EXCEPT !.phase = "succeeded"]
    /\ UNCHANGED <<db, files, attempts, faults>>

ExitProcess ==
    /\ job.phase \in WorkPhases
    /\ "exit" \notin faults
    /\ faults' = faults \cup {"exit"}
    /\ job' = [job EXCEPT !.phase = "down"]
    /\ UNCHANGED <<db, files, attempts>>

Restart ==
    /\ job.phase = "down"
    /\ job' = [job EXCEPT !.phase = "interrupted"]
    /\ UNCHANGED <<db, files, attempts, faults>>

\* The snapshots and todo in a terminal job are for checking only. No restart
\* or subsequent request consumes that todo. Begin always plans from live DB.
Progress == Commit \/ Abort \/ (\E copy \in Copies : Unlink(copy))
            \/ DirectoryDone \/ CleanupFails \/ Finish \/ ExitProcess \/ Restart
Next == (\E r \in Requests : Begin(r)) \/ Progress
Spec == Init /\ [][Next]_vars /\ WF_vars(Progress)

DbType == [trips : SUBSET Trips, items : SUBSET Images,
           batchOwner : Trips \cup {NoOwner}, imports : SUBSET Images,
           importOwner : [Images -> Trips \cup {NoOwner}],
           sources : SUBSET Images, receiptLinks : SUBSET (Images \X Images)]
TypeOK ==
    /\ db \in DbType
    /\ files \subseteq AllFiles
    /\ job.request \in Requests \cup {NoRequest}
    /\ job.phase \in IdlePhases \cup WorkPhases \cup {"down"}
    /\ job.committed \in BOOLEAN
    /\ job.beforeDb \in DbType
    /\ job.beforeFiles \subseteq AllFiles
    /\ job.targets \subseteq Images
    /\ Len(job.todo) <= Cardinality(Images)
    /\ \A i \in DOMAIN job.todo : job.todo[i] \in job.targets
    /\ attempts \in 0..MaxRequests
    /\ faults \subseteq {"cleanup", "exit"}

ReferencedFilesPresent == CopyFiles(References(db)) \subseteq files

\* State predicates derive the permitted effect from the admitted request and
\* the pre-request DB. They do not use the candidate list or remaining todo.
ExpectedTargets ==
    LET r == job.request
        d == job.beforeDb
    IN CASE r.kind = "none" -> {}
         [] r.kind = "trip" ->
            LET batchIds == IF d.batchOwner = r.target THEN d.items ELSE {}
                singleIds == {id \in (d.imports \ d.items) : d.importOwner[id] = r.target}
            IN (batchIds \cup singleIds) \ d.sources
         [] OTHER -> {r.target}

OnlyTargetsLoseFiles == (job.beforeFiles \ files) \subseteq CopyFiles(ExpectedTargets)
SuccessClearsOnlyTargets ==
    job.phase = "succeeded" => files = job.beforeFiles \ CopyFiles(ExpectedTargets)

UncommittedDbUnchanged == ~job.committed => db = job.beforeDb
AbortKeepsSnapshot ==
    job.phase = "aborted" => db = job.beforeDb /\ files = job.beforeFiles

CommitKeepsOtherReferences ==
    job.committed =>
      LET d == job.beforeDb
          r == job.request
          ids == ExpectedTargets
          deletedTrip == IF r.kind = "trip" THEN {r.target} ELSE {}
      IN /\ db.trips = d.trips \ deletedTrip
         /\ db.items = d.items \ ids
         /\ db.imports = d.imports \ ids
         /\ db.sources = d.sources \ ids
         /\ db.receiptLinks = {link \in d.receiptLinks : {link[1], link[2]} \cap ids = {}}
         /\ (db.items # {} =>
               db.batchOwner = IF d.batchOwner \in deletedTrip THEN NoOwner ELSE d.batchOwner)
         /\ \A id \in db.imports :
               db.importOwner[id] = IF d.importOwner[id] \in deletedTrip
                                    THEN NoOwner ELSE d.importOwner[id]

EventuallyNoOrphans == \A file \in AllFiles : (file \in Orphans) ~> (file \notin files)
CleanupWithoutInterruption == ([](faults = {})) => EventuallyNoOrphans
=============================================================================
