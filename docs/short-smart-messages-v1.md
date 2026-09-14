# Short customer messages and links

The user requested shorter acceptance and GATI messages because customers were
unlikely to read the long copy. The family HMAC payload also made the visible URL
unnecessarily long.

Smart Message now uses a personal `/k/s_<opaque code>` link (52 characters). The
Base/Transport acceptance and ready templates keep the name, status, permanent
code, quantity, total, next action, link and company phone. Base ready retains the
24-hour collection request. Transport ready requests a reply to arrange delivery
without promising an unplanned departure time. The short link caption is
“Statusi dhe familjarët:”. Other operational flows retain their existing actions.

Migration `20260914020227_client_family_short_links_v1` adds a service-only table
with RLS. It stores SHA-256 token digests and exact source/order/client bindings.
Opaque codes have 128 HMAC-derived bits and are reused for the same order/client
within a UTC day. Public resolution rechecks the current order owner. Contact
access expires within 30 days; tracking remains available afterward. Existing
signed links and source-qualified tracking URLs remain supported. A missing new
table falls back to the existing signed link during rollout. Public tracking
responses suppress referrers and caching.

Verification:

- 16 short-link/message cases: both modules, source/order tampering, unknown
  codes, ownership changes, public contact append/retry, expiry, legacy links,
  table grants, endpoint authentication/origin and messages below 300 characters.
- Actual React/API/SQL tracking tests open the short Base and Transport URLs and
  submit the family form. Legacy tracking and invalid old tokens remain covered.
- The full production/PWA build passed, including the prior SMS quota repair.
- The live migration was verified with RLS enabled, no anonymous table access and
  server insert access. No client/contact/order records were changed for rollout.

Client verification requested by the user: Base code 54 had two distinct phones.
The submission contained one existing primary phone and one new family phone;
the duplicate primary was not added twice. Both stored phones returned only code
54 through the real family search. No correction of the customer's data was needed.

Previous production commit: `f361e1df65f2e60c23bd8106a1051c17d688aae6`. The private
pre-family snapshot remains available. Preserve the short-link resolver/table
during any UI rollback after links have been shared so delivered links still work.
