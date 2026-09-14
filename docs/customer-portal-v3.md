# Customer portal v3

Customer tracking now uses a scoped light palette, consistent outline SVG icons,
clear company identity and phone contact, restrained type and white cards. The
status disclosure is labeled Statusi. An unmeasured empty pickup displays
Pas matjes rather than an apparent zero-price quote; calculated amounts retain
the existing extractor and formatting. Family copy explains who to add, how the
family card avoids code confusion and that permanent codes are retained.

The primary location button obtains GPS and sends it in one explicit action.
The explanation beneath tells the customer to use it at the driver's destination.
Written address/entrance details are collapsed and open when GPS is unavailable.
Success requires a server save acknowledgment. Lost responses preserve the exact
request ID and coordinates, disable new submissions and offer a retry without
requesting a different GPS reading. The address alternative, token boundaries,
request validation and legacy unsigned tracking links remain supported.

Driver maps now query the same authenticated exact-visit GET_LOCATION endpoint
as Dispatch. This includes Inbox and the shared maps used in other transport
stages. Latest customer submissions take priority over legacy GPS; address-only
submissions open address search. Read failures show an error rather than silently
navigating to stale coordinates. Validated legacy GPS/address remains available
when there is no customer submission. Map URLs use HTTPS Google Maps and
same-tab navigation so asynchronous reads do not require mobile popup permission.
No production customer/order/payment records or schema are modified by this
release. The user's earlier test GPS removal remains in place.

Validation: 14 actual tracking/family React DOM/API/SQL scenarios plus 18 location,
Dispatch and driver-map scenarios; complete production build gates. Includes one
GPS form, a single-click save, GPS denial, ambiguous-response retry without GPS
recapture, exact-visit driver map lookup, invalid/zero coordinates, failure paths,
family forms, old links, phone privacy, no unsolicited geolocation and unchanged
source/financial rows. These are DOM/API/SQL checks, not physical iPhone visual
or native map handoff verification. No messages sent to customers during tests.

Prior production rollback: f01fbf3bcf58e90017498e6ac3a81a80a30ac005,
deployment dpl_H8ztdQ9esUqJ6Exj1WSrKmkvop79. Existing customer location records
must be retained across application rollback.
