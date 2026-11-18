----------------------- MODULE ImageCleanupDiscovery -----------------------
CONSTANT HideRetiredSettings

Owner == "owner"
OtherGuest == "otherGuest"
Guests == {Owner, OtherGuest}
Surfaces == {"import", "settings", "legacySettings"}
Removal == [batchId |-> "batch", imageId |-> "image", revision |-> 2]
Copies == {"original", "normalized"}
View(result, offers) == [result |-> result, offers |-> offers]
Unloaded == View("unloaded", {})

VARIABLES batchActive, cleanupIds, files, healthy, snapshots
vars == <<batchActive, cleanupIds, files, healthy, snapshots>>

\* Start after logical removal committed and its first cleanup failed.
Init ==
    /\ batchActive = TRUE
    /\ cleanupIds = [g \in Guests |-> IF g = Owner THEN {Removal.imageId} ELSE {}]
    /\ files = Copies
    /\ healthy = FALSE
    /\ snapshots = [g \in Guests |-> [s \in Surfaces |-> Unloaded]]

Pending(g) == Removal.imageId \in cleanupIds[g]

\* The import request already supplies batchId. The newer settings response
\* also supplies batchId. Normalize both offers to the same replay key.
Fresh(g, surface) ==
    CASE surface = "import" ->
         IF g = Owner /\ batchActive
         THEN View("ok", IF Pending(g) THEN {Removal} ELSE {})
         ELSE View("missing", {})
      [] surface = "settings" ->
         View("ok", IF ~HideRetiredSettings /\ ~batchActive /\ Pending(g)
                    THEN {Removal} ELSE {})
      [] surface = "legacySettings" -> View("ok", {})

Read(g, surface) ==
    /\ snapshots' = [snapshots EXCEPT ![g][surface] = Fresh(g, surface)]
    /\ UNCHANGED <<batchActive, cleanupIds, files, healthy>>

Reload(g) ==
    /\ snapshots' = [snapshots EXCEPT ![g] = [s \in Surfaces |-> Unloaded]]
    /\ UNCHANGED <<batchActive, cleanupIds, files, healthy>>

Retire ==
    /\ batchActive
    /\ batchActive' = FALSE
    /\ UNCHANGED <<cleanupIds, files, healthy, snapshots>>

Repair ==
    /\ ~healthy
    /\ healthy' = TRUE
    /\ UNCHANGED <<batchActive, cleanupIds, files, snapshots>>

Retry(g, surface) ==
    /\ Removal \in snapshots[g][surface].offers
    /\ Pending(g)
    /\ IF healthy
       THEN /\ files' = {}
            /\ cleanupIds' = [cleanupIds EXCEPT ![g] = {}]
            /\ snapshots' = [snapshots EXCEPT ![g][surface] =
                                IF surface = "import" /\ batchActive
                                THEN View("ok", {}) ELSE Unloaded]
       ELSE /\ files' \in SUBSET files
            /\ UNCHANGED <<cleanupIds, snapshots>>
    /\ UNCHANGED <<batchActive, healthy>>

Next == Retire \/ Repair
        \/ (\E g \in Guests : Reload(g))
        \/ (\E g \in Guests, s \in Surfaces : Read(g, s) \/ Retry(g, s))

\* A continuously useful owner read eventually happens. Reload can repeatedly
\* disable the button, so retry requires strong fairness once the fault clears.
OwnerHealthyRetry == healthy /\ (\E s \in Surfaces : Retry(Owner, s))
Spec == Init /\ [][Next]_vars
             /\ WF_vars(Read(Owner, "import"))
             /\ WF_vars(Read(Owner, "settings"))
             /\ SF_vars(OwnerHealthyRetry)

TypeOK ==
    /\ batchActive \in BOOLEAN
    /\ cleanupIds \in [Guests -> SUBSET {Removal.imageId}]
    /\ files \subseteq Copies
    /\ healthy \in BOOLEAN
    /\ snapshots \in [Guests -> [Surfaces ->
         [result : {"ok", "missing", "unloaded"}, offers : SUBSET {Removal}]]]

LiveDiscovery == (batchActive /\ Pending(Owner)) =>
    /\ Fresh(Owner, "import") = View("ok", {Removal})
    /\ Fresh(Owner, "settings") = View("ok", {})

RetiredDiscovery == (~batchActive /\ Pending(Owner)) =>
    /\ Fresh(Owner, "import") = View("missing", {})
    /\ Fresh(Owner, "settings") = View("ok", {Removal})

CompletedDiscovery == ~Pending(Owner) =>
    /\ files = {}
    /\ \A s \in Surfaces : Fresh(Owner, s).offers = {}

IsolatedDiscovery ==
    /\ Fresh(OtherGuest, "import") = View("missing", {})
    /\ \A s \in Surfaces :
          /\ Fresh(OtherGuest, s).offers = {}
          /\ snapshots[OtherGuest][s].offers = {}
    /\ Fresh(Owner, "legacySettings") = View("ok", {})
    /\ snapshots[Owner]["legacySettings"].offers = {}

HealthyPendingEventuallyCompletes == (healthy /\ Pending(Owner)) ~> ~Pending(Owner)

\* Only the submitting view is updated on success. Any other old offer
\* disappears on its next successful read or reload, under the read fairness.
OwnerOffersEmpty == \A s \in Surfaces : snapshots[Owner][s].offers = {}
CompletedSnapshotsEventuallyClear == ~Pending(Owner) ~> OwnerOffersEmpty
=============================================================================
