// No-network stand-in for @/lib/active-client: presence is best-effort in
// prod; in tests it must never fetch, and reporting "not the active client"
// keeps voice autoplay paths quiescent.
export function getClientId() {
    return "test-client";
}

export function reportClientActivity() {}

let active = false;
export function setActiveClient(value) { active = value; }
export async function isThisClientActive() {
    return typeof active === "function" ? active() : active;
}
