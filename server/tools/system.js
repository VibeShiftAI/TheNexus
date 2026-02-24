const si = require('systeminformation');
const { z } = require("zod");

const tools = [
    {
        name: "check_ports",
        description: "List all active listening ports and the processes running on them. Use this to find what's running or debugging port conflicts.",
        schema: z.object({
            filter_port: z.number().optional().describe("Optional: Only show specifics for this port")
        }),
        execute: async ({ filter_port }) => {
            try {
                const connections = await si.networkConnections();

                // Filter for listening connections on meaningful ports
                let listening = connections
                    .filter(conn => conn.state === 'LISTEN')
                    .map(conn => ({
                        port: parseInt(conn.localPort, 10),
                        pid: conn.pid,
                        process: conn.process || 'unknown',
                        protocol: conn.protocol
                    }));

                if (filter_port) {
                    listening = listening.filter(p => p.port === filter_port);
                }

                // Sort and deduplicate
                const unique = [];
                const seen = new Set();
                listening.sort((a, b) => a.port - b.port);

                for (const item of listening) {
                    const key = `${item.port}-${item.pid}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        unique.push(item);
                    }
                }

                if (unique.length === 0) {
                    return { content: filter_port ? `No process found listening on port ${filter_port}.` : "No active listening ports found." };
                }

                return { content: JSON.stringify(unique, null, 2) };
            } catch (error) {
                return { isError: true, content: `Failed to check ports: ${error.message}` };
            }
        }
    },
    {
        name: "kill_process",
        description: "Terminate a process by PID or Port. Warning: This is a destructive action.",
        schema: z.object({
            pid: z.number().optional().describe("The Process ID to kill"),
            port: z.number().optional().describe("The Port number to free up (will kill the process listening on it)"),
            force: z.boolean().optional().describe("Force kill (default: false)")
        }),
        execute: async ({ pid, port, force = false }) => {
            try {
                if (!pid && !port) {
                    return { isError: true, content: "You must provide either a 'pid' or a 'port' to kill a process." };
                }

                let targetPid = pid;
                let details = "";

                // If port provided, resolve to PID
                if (port && !targetPid) {
                    const connections = await si.networkConnections();
                    const match = connections.find(c => c.state === 'LISTEN' && parseInt(c.localPort, 10) === port);

                    if (!match) {
                        return { isError: true, content: `No active process found listening on port ${port}.` };
                    }
                    targetPid = match.pid;
                    details = ` (Found listening on port ${port})`;
                }

                if (!targetPid) {
                    return { isError: true, content: "Could not resolve a valid PID to kill." };
                }

                // Execute kill
                // Using process.kill() or system command for wider compatibility
                try {
                    process.kill(targetPid, 0); // Check if process exists
                } catch (e) {
                    return { isError: true, content: `Process with PID ${targetPid} does not exist or access is denied.` };
                }

                process.kill(targetPid, force ? 'SIGKILL' : 'SIGTERM');

                return { content: `Successfully sent active termination signal to PID ${targetPid}${details}.` };

            } catch (error) {
                return { isError: true, content: `Failed to kill process: ${error.message}` };
            }
        }
    }
];

module.exports = tools;
