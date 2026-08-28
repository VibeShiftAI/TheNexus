// Minimal next/link stand-in: a plain anchor, which is what Link renders to.
import { createElement } from "react";

export default function Link({ href, children, ...props }) {
    return createElement("a", { href, ...props }, children);
}
