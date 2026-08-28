// Minimal next/navigation stand-in for components rendered outside a Next
// app router context.
export function useParams() {
    return {};
}

export function useRouter() {
    return { push() {}, replace() {}, back() {}, prefetch() {} };
}

export function usePathname() {
    return "/";
}
