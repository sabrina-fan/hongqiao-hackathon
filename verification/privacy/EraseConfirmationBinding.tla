---------------------- MODULE EraseConfirmationBinding ----------------------

CONSTANT LegacyOrdinary

VARIABLES cookie, dialogs, trips, revoked, cleanupBlocked, lastErase

vars == <<cookie, dialogs, trips, revoked, cleanupBlocked, lastErase>>

Tabs == {"A", "B"}
Guests == {"original", "replacement"}
NoGuest == "none"
GuestOrNone == Guests \cup {NoGuest}
Modes == {"closed", "ordinary", "recovery"}
Closed == [guest |-> NoGuest, mode |-> "closed"]
Confirmation == {Closed} \cup [guest : Guests, mode : Modes \ {"closed"}]

\* Record the pre-request state for checking effects independently of admission.
NoErase == [tab |-> "none", confirmedFor |-> NoGuest, mode |-> "closed",
            sentBinding |-> NoGuest, requestCookie |-> NoGuest, status |-> "none",
            priorTrips |-> {}, priorRevoked |-> {}]

Init ==
    /\ cookie = "original"
    /\ dialogs = [tab \in Tabs |-> Closed]
    /\ trips = {"original"}
    /\ revoked = {}
    /\ cleanupBlocked \in BOOLEAN
    /\ lastErase = NoErase

OpenConfirmation(tab) ==
    /\ cookie \in Guests
    /\ dialogs[tab] = Closed
    \* Fresh Settings read and confirmation click are one step.
    /\ dialogs' = [dialogs EXCEPT ![tab] =
          [guest |-> cookie, mode |-> IF cookie \in revoked THEN "recovery" ELSE "ordinary"]]
    /\ lastErase' = NoErase
    /\ UNCHANGED <<cookie, trips, revoked, cleanupBlocked>>

DismissConfirmation(tab) ==
    /\ dialogs[tab] # Closed
    /\ dialogs' = [dialogs EXCEPT ![tab] = Closed]
    /\ lastErase' = NoErase
    /\ UNCHANGED <<cookie, trips, revoked, cleanupBlocked>>

SubmitErase(tab, sendsBinding) ==
    LET confirmation == dialogs[tab]
        legacy == LegacyOrdinary /\ confirmation.mode = "ordinary"
        binding == IF sendsBinding /\ ~legacy THEN confirmation.guest ELSE NoGuest
        allowed == /\ cookie \in Guests
                   /\ legacy \/ binding = cookie
                   /\ confirmation.mode # "recovery" \/ cookie \in revoked
        status == IF ~allowed THEN "401" ELSE IF cleanupBlocked THEN "500" ELSE "204"
    IN /\ confirmation # Closed
       /\ lastErase' = [tab |-> tab, confirmedFor |-> confirmation.guest,
                        mode |-> confirmation.mode, sentBinding |-> binding,
                        requestCookie |-> cookie, status |-> status,
                        priorTrips |-> trips, priorRevoked |-> revoked]
       /\ revoked' = IF allowed THEN revoked \cup {cookie} ELSE revoked
       /\ trips' \in CASE status = "204" -> {trips \ {cookie}}
                       [] status = "500" -> {trips, trips \ {cookie}}
                       [] OTHER -> {trips}
       /\ cookie' = IF status = "204" THEN NoGuest ELSE cookie
       \* Failure keeps the same confirmation for retry. A 401 models closing
       \* the expired confirmation via Return to current settings.
       /\ dialogs' = IF status = "500" THEN dialogs ELSE [dialogs EXCEPT ![tab] = Closed]
       /\ UNCHANGED cleanupBlocked

Repair ==
    /\ cleanupBlocked
    /\ cleanupBlocked' = FALSE
    /\ lastErase' = NoErase
    /\ UNCHANGED <<cookie, dialogs, trips, revoked>>

IssueReplacement ==
    /\ cookie = NoGuest
    /\ "original" \in revoked
    /\ "replacement" \notin revoked
    /\ cookie' = "replacement"
    /\ lastErase' = NoErase
    /\ UNCHANGED <<dialogs, trips, revoked, cleanupBlocked>>

SaveReplacementTrip ==
    /\ cookie = "replacement"
    /\ cookie \notin (trips \cup revoked)
    /\ trips' = trips \cup {cookie}
    /\ lastErase' = NoErase
    /\ UNCHANGED <<cookie, dialogs, revoked, cleanupBlocked>>

Next ==
    \/ \E tab \in Tabs : OpenConfirmation(tab) \/ DismissConfirmation(tab)
    \/ \E tab \in Tabs, sendsBinding \in BOOLEAN : SubmitErase(tab, sendsBinding)
    \/ Repair
    \/ IssueReplacement
    \/ SaveReplacementTrip

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ cookie \in GuestOrNone
    /\ dialogs \in [Tabs -> Confirmation]
    /\ trips \subseteq Guests
    /\ revoked \subseteq Guests
    /\ cleanupBlocked \in BOOLEAN
    /\ lastErase \in [tab : Tabs \cup {"none"}, confirmedFor : GuestOrNone,
                      mode : Modes, sentBinding : GuestOrNone, requestCookie : GuestOrNone,
                      status : {"none", "401", "500", "204"},
                      priorTrips : SUBSET Guests, priorRevoked : SUBSET Guests]

Attempted == lastErase.status # "none"

NoCrossSessionTripDeletion ==
    Attempted => (lastErase.priorTrips \ {lastErase.confirmedFor}) \subseteq trips

NoCrossSessionRevocation ==
    Attempted => revoked \ {lastErase.confirmedFor} =
                 lastErase.priorRevoked \ {lastErase.confirmedFor}

StaleConfirmationIsRejected ==
    (Attempted /\ lastErase.confirmedFor # lastErase.requestCookie) => lastErase.status = "401"

UnboundRequestIsRejected ==
    (Attempted /\ lastErase.sentBinding = NoGuest) => lastErase.status = "401"

RejectedEraseHasNoServerEffects ==
    lastErase.status = "401" =>
        /\ trips = lastErase.priorTrips
        /\ revoked = lastErase.priorRevoked
        /\ cookie = lastErase.requestCookie

AcceptedEraseLifecycle ==
    lastErase.status \in {"500", "204"} =>
        /\ lastErase.requestCookie \in revoked
        /\ lastErase.mode = "recovery" => lastErase.requestCookie \in lastErase.priorRevoked
        /\ IF lastErase.status = "500"
           THEN /\ cookie = lastErase.requestCookie
                /\ dialogs[lastErase.tab] =
                    [guest |-> lastErase.confirmedFor, mode |-> lastErase.mode]
           ELSE /\ cookie = NoGuest
                /\ lastErase.requestCookie \notin trips
                /\ dialogs[lastErase.tab] = Closed

=============================================================================
