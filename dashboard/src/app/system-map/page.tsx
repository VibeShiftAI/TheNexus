import type { Metadata } from "next";
import { SystemMapView } from "@/components/system-map/system-map-view";
// Imported here, not in the component, so the component mounts in the node test harness.
import "@/components/system-map/system-map.css";

export const metadata: Metadata = { title: "System Map - The Nexus" };

/**
 * The generated fleet map, browsable: services, components and their
 * connections, the job schedule, routes, drift and the boundary. Read-only;
 * live health and usage stay on /system-monitor.
 */
export default function SystemMapPage() {
    return <SystemMapView />;
}
