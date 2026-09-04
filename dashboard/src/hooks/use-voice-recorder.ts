"use client";

/**
 * useVoiceRecorder — the composer's voice-memo lane: MediaRecorder capture,
 * the elapsed-seconds counter, the recorded blob and its preview object URL.
 *
 * Extracted verbatim from ai-terminal.tsx (P2-27, 2026-09-03). The recorded
 * memo is uploaded by the terminal's send path; this hook only captures it.
 */

import { useRef, useState } from "react";

import type { Message } from "@/components/cortex-provider";

export interface VoiceRecorderApi {
    isRecording: boolean;
    recordingTime: number;
    audioBlob: Blob | null;
    audioPreviewUrl: string | null;
    startRecording: () => Promise<void>;
    stopRecording: () => void;
    clearAudio: () => void;
}

export function useVoiceRecorder(
    setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): VoiceRecorderApi {
    // Voice recording state
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const audioChunksRef = useRef<Blob[]>([]);
    const recordingTimerRef = useRef<NodeJS.Timeout | null>(null);
    const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
    const [audioPreviewUrl, setAudioPreviewUrl] = useState<string | null>(null);

    // Audio recording functions
    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                setAudioBlob(blob);
                setAudioPreviewUrl(URL.createObjectURL(blob));
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorder.start();
            setIsRecording(true);
            setRecordingTime(0);
            recordingTimerRef.current = setInterval(() => {
                setRecordingTime(prev => prev + 1);
            }, 1000);
        } catch (err) {
            console.error("Error accessing microphone:", err);
            setMessages(prev => [...prev, {
                role: 'system',
                content: 'Error: Could not access microphone. Please check permissions.',
                timestamp: new Date()
            }]);
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && isRecording) {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            if (recordingTimerRef.current) {
                clearInterval(recordingTimerRef.current);
            }
        }
    };

    const clearAudio = () => {
        setAudioBlob(null);
        if (audioPreviewUrl) {
            URL.revokeObjectURL(audioPreviewUrl);
            setAudioPreviewUrl(null);
        }
    };

    return { isRecording, recordingTime, audioBlob, audioPreviewUrl, startRecording, stopRecording, clearAudio };
}
