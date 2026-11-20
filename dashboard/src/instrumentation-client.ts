import { withNexusReadBackoff } from "./lib/poll-fetch";

window.fetch = withNexusReadBackoff(window.fetch.bind(window), window.location.origin);
