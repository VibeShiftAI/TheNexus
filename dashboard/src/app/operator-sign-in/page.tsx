import { OperatorSignInForm } from "@/components/local-operator-sign-in";

export default function OperatorSignInPage() {
    return <section className="mx-auto max-w-xl space-y-5 p-8">
        <h1 className="text-2xl font-semibold text-slate-100">Local operator sign-in</h1>
        <OperatorSignInForm />
        <a href="/" className="inline-block text-sm text-cyan-300">Return to Nexus</a>
    </section>;
}
