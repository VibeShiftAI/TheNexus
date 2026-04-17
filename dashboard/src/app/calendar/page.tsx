"use client"

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Plus, X, Calendar as CalendarIcon, Save, Clock, AlignLeft, CheckCircle2 } from "lucide-react";

export default function CalendarPage() {
    const [events, setEvents] = useState([]);
    const [loading, setLoading] = useState(true);
    const [selectedEvent, setSelectedEvent] = useState(null);
    const [isEditModalOpen, setIsEditModalOpen] = useState(false);

    // Form state
    const [editForm, setEditForm] = useState({
        title: "",
        start_time: "",
        end_time: "",
        description: "",
        result: "",
        status: "scheduled"
    });

    const loadEvents = async () => {
        try {
            const today = new Date();
            const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
            const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();
            const res = await fetch(`http://localhost:4000/api/calendar?start=${startOfDay}&end=${endOfDay}`);
            const data = await res.json();
            setEvents(data);
        } catch (e) {
            console.error("Failed to load events", e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadEvents();
    }, []);

    const hours = Array.from({ length: 24 }, (_, i) => i);

    const openEditModal = (event = null, hour = null) => {
        if (event) {
            setSelectedEvent(event);
            setEditForm({
                title: event.title,
                start_time: event.start_time,
                end_time: event.end_time || "",
                description: event.description || "",
                result: event.result || "",
                status: event.status || "scheduled"
            });
        } else {
            setSelectedEvent(null);
            const now = new Date();
            if (hour !== null) {
                now.setHours(hour, 0, 0, 0);
            }
            const endTime = new Date(now.getTime() + 60 * 60 * 1000);
            
            // Format to basic string to fit datetime-local input safely
            const toLocalISO = (d) => {
                const pad = n => n.toString().padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
            };
            
            setEditForm({
                title: "",
                start_time: toLocalISO(now),
                end_time: toLocalISO(endTime),
                description: "",
                result: "",
                status: "scheduled"
            });
        }
        setIsEditModalOpen(true);
    };

    const saveEvent = async () => {
        try {
            const payload = {
                title: editForm.title,
                start_time: new Date(editForm.start_time).toISOString(),
                end_time: new Date(editForm.end_time).toISOString(),
                description: editForm.description,
                result: editForm.result,
                status: editForm.status,
                event_type: 'praxis_task'
            };

            if (selectedEvent) {
                await fetch(`http://localhost:4000/api/calendar/${selectedEvent.id}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } else {
                await fetch(`http://localhost:4000/api/calendar`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            }
            setIsEditModalOpen(false);
            loadEvents();
        } catch (e) {
            console.error("Failed to save event", e);
        }
    };

    // Helper to calculate top and height of an event block visually
    const getEventStyle = (event) => {
        const start = new Date(event.start_time);
        const end = event.end_time ? new Date(event.end_time) : new Date(start.getTime() + 3600000);
        
        const startMinutes = start.getHours() * 60 + start.getMinutes();
        const endMinutes = end.getHours() * 60 + end.getMinutes();
        
        let duration = endMinutes - startMinutes;
        if (duration < 30) duration = 30; // Minimum visual height
        
        // 60px per hour
        const top = (startMinutes / 60) * 80;
        const height = (duration / 60) * 80;
        
        return {
            top: `${top}px`,
            height: `${height}px`,
            position: 'absolute' as 'absolute',
            left: '0',
            right: '0'
        };
    };

    return (
        <main className="min-h-screen bg-slate-950 text-slate-200">
            {/* Header HUD */}
            <header className="sticky top-0 z-50 border-b border-slate-800 bg-slate-950/80 backdrop-blur-md">
                <div className="container mx-auto flex h-16 items-center justify-between px-6">
                    <div className="flex items-center gap-4">
                        <Link href="/" className="p-2 rounded-full hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                            <ChevronLeft size={20} />
                        </Link>
                        <div className="flex items-center gap-2">
                            <CalendarIcon size={20} className="text-cyan-500" />
                            <h1 className="text-xl font-bold tracking-tight text-white">
                                NEXUS <span className="text-cyan-400">CALENDAR</span>
                            </h1>
                        </div>
                    </div>
                    <button
                        onClick={() => openEditModal()}
                        className="flex items-center gap-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 px-4 py-2 text-sm font-medium text-white hover:from-cyan-600 hover:to-purple-600 shadow-lg shadow-cyan-500/20"
                    >
                        <Plus size={16} />
                        <span>Add Event</span>
                    </button>
                </div>
            </header>

            <div className="container mx-auto p-6 max-w-5xl">
                <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                    <div className="p-4 border-b border-slate-800 bg-slate-800/50 flex justify-between items-center">
                        <h2 className="text-lg font-semibold text-slate-200">Today's Schedule</h2>
                        <span className="text-sm text-slate-400">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
                    </div>

                    <div className="relative overflow-y-auto h-[70vh] bg-slate-900 hide-scrollbar" style={{ position: 'relative' }}>
                        {loading && <div className="p-8 text-center text-slate-500">Loading schedule...</div>}
                        
                        {!loading && (
                            <div className="relative pt-4 pb-20">
                                {/* Time Grid Lines */}
                                {hours.map(hour => (
                                    <div key={hour} className="flex relative items-start h-[80px]">
                                        <div className="w-20 text-right pr-4 text-xs font-medium text-slate-500 -mt-2">
                                            {hour === 0 ? '12 AM' : hour < 12 ? `${hour} AM` : hour === 12 ? '12 PM' : `${hour - 12} PM`}
                                        </div>
                                        <div 
                                            className="flex-1 border-t border-slate-800/60 h-full relative group cursor-pointer"
                                            onClick={() => openEditModal(null, hour)}
                                        >
                                            <div className="absolute inset-0 bg-slate-800/0 group-hover:bg-slate-800/20 transition-colors" />
                                        </div>
                                    </div>
                                ))}

                                {/* Event Blocks Overlay */}
                                <div className="absolute top-4 left-20 right-4 bottom-0 pointer-events-none">
                                    <div className="relative w-full h-full">
                                        {events.map((event, i) => (
                                            <div 
                                                key={event.id || i}
                                                className={`pointer-events-auto rounded-md shadow-lg border p-3 flex flex-col transition-transform hover:scale-[1.01] hover:z-10 cursor-pointer overflow-hidden ${
                                                    event.status === 'in_progress' ? 'bg-amber-500/20 border-amber-500/50 shadow-amber-500/10' :
                                                    event.status === 'completed' ? 'bg-emerald-500/20 border-emerald-500/50 shadow-emerald-500/10' :
                                                    'bg-cyan-500/20 border-cyan-500/50 shadow-cyan-500/10'
                                                }`}
                                                style={getEventStyle(event)}
                                                onClick={() => openEditModal(event)}
                                            >
                                                <div className="flex justify-between items-start gap-2">
                                                    <h3 className={`font-bold text-sm line-clamp-1 ${
                                                        event.status === 'in_progress' ? 'text-amber-300' :
                                                        event.status === 'completed' ? 'text-emerald-300' :
                                                        'text-cyan-300'
                                                    }`}>{event.title}</h3>
                                                    <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded opacity-70 bg-black/40">
                                                        {event.status}
                                                    </span>
                                                </div>
                                                
                                                {event.description && (
                                                    <p className="text-xs text-slate-300 mt-1 opacity-80 line-clamp-2 leading-tight">
                                                        {event.description}
                                                    </p>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Edit / Detail Modal */}
            {isEditModalOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm p-4">
                    <div className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                        <div className="flex justify-between items-center p-5 border-b border-slate-800 bg-slate-800/40">
                            <h2 className="text-lg font-bold text-white flex items-center gap-2">
                                {selectedEvent ? 'Edit Schedule Event' : 'Create Schedule Event'}
                            </h2>
                            <button onClick={() => setIsEditModalOpen(false)} className="p-1 rounded-full text-slate-400 hover:bg-slate-800 hover:text-white">
                                <X size={20} />
                            </button>
                        </div>
                        
                        <div className="p-6 overflow-y-auto flex-1 space-y-6">
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Title</label>
                                <input 
                                    type="text" 
                                    value={editForm.title}
                                    onChange={e => setEditForm({...editForm, title: e.target.value})}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                                    placeholder="Task or Event Name"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1"><Clock size={12}/> Start Time</label>
                                    <input 
                                        type="datetime-local" 
                                        value={editForm.start_time}
                                        onChange={e => setEditForm({...editForm, start_time: e.target.value})}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1"><Clock size={12}/> End Time</label>
                                    <input 
                                        type="datetime-local" 
                                        value={editForm.end_time}
                                        onChange={e => setEditForm({...editForm, end_time: e.target.value})}
                                        className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1"><AlignLeft size={12}/> Comments / Instructions for Praxis</label>
                                <textarea 
                                    value={editForm.description}
                                    onChange={e => setEditForm({...editForm, description: e.target.value})}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500 min-h-[100px]"
                                    placeholder="Write instructions or context that Praxis should see before starting this."
                                />
                            </div>
                            
                            <div>
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-1"><CheckCircle2 size={12}/> Task Results / Output</label>
                                <textarea 
                                    value={editForm.result}
                                    onChange={e => setEditForm({...editForm, result: e.target.value})}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-emerald-400 focus:outline-none focus:border-cyan-500 min-h-[80px]"
                                    placeholder="Praxis will log the result here once the task finishes."
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Status</label>
                                <select 
                                    value={editForm.status}
                                    onChange={e => setEditForm({...editForm, status: e.target.value})}
                                    className="w-full bg-slate-950 border border-slate-700 rounded-md px-3 py-2 text-slate-200 focus:outline-none focus:border-cyan-500"
                                >
                                    <option value="scheduled">Scheduled</option>
                                    <option value="in_progress">In Progress</option>
                                    <option value="completed">Completed</option>
                                    <option value="skipped">Skipped</option>
                                </select>
                            </div>
                        </div>
                        
                        <div className="p-5 border-t border-slate-800 bg-slate-800/40 flex justify-end gap-3 rounded-b-xl">
                            <button 
                                onClick={() => setIsEditModalOpen(false)}
                                className="px-4 py-2 font-medium text-slate-300 hover:text-white"
                            >
                                Cancel
                            </button>
                            <button 
                                onClick={saveEvent}
                                className="px-6 py-2 rounded-lg bg-gradient-to-r from-cyan-500 to-purple-500 font-bold text-white shadow-lg shadow-cyan-500/20 hover:from-cyan-400 hover:to-purple-400 flex items-center gap-2"
                            >
                                <Save size={16} /> Save Event
                            </button>
                        </div>
                    </div>
                </div>
            )}

            <style dangerouslySetInnerHTML={{__html: `
            .hide-scrollbar::-webkit-scrollbar {
                display: none;
            }
            .hide-scrollbar {
                -ms-overflow-style: none;
                scrollbar-width: none;
            }
            `}} />
        </main>
    );
}
