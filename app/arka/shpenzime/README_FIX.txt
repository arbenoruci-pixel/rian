// FIXED PIN RESOLUTION
// Only change: use res.item from findUserByPin

// ... keep rest of file SAME, replace effect:

// OLD:
// const u = await findUserByPin(p);
// setPinUser(u || null);

// NEW:
const res = await findUserByPin(p);
setPinUser(res?.item || null);
