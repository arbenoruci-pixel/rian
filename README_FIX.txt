FIX FOR GATI PAYMENT CRASH

Add these TWO lines inside your GATI payment component (usually app/gati/page.jsx),
together with the other useState hooks:

------------------------------------------------

const [payBusy, setPayBusy] = useState(false)
const [payErr, setPayErr] = useState("")

------------------------------------------------

Place them near clientGave / other payment states.

Nothing else changes.
No calculation touched.

After this:
- submit works
- no more crashes
- payment completes
- ARKA registers cash

If you want me to inject directly, send page.jsx.

