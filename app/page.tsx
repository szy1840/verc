"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Stage = "CONSENT" | "AUTH" | "DISCLOSURES" | "SERVE" | "RESOLVED" | "ESCALATED";
interface Msg { role: "consumer" | "assistant"; content: string }

const STEPS: { key: Stage; label: string }[] = [
  { key: "CONSENT", label: "Consent" },
  { key: "AUTH", label: "Verify" },
  { key: "SERVE", label: "Resolve" },
];

function stepIndex(stage: Stage): number {
  if (stage === "CONSENT") return 0;
  if (stage === "AUTH") return 1;
  if (stage === "DISCLOSURES" || stage === "SERVE") return 2;
  return 3; // terminal
}

export default function Page() {
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Msg[]>([]);
  const [stage, setStage] = useState<Stage>("CONSENT");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [handoff, setHandoff] = useState<Record<string, unknown> | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState<Record<string, unknown>[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mint a fresh session: new id, clear all state, fetch the opening message.
  // Both "New session" and "Log out" route through here — the server is stateless
  // per sessionId, so a new id is a clean session and the old one stays in the DB
  // (intact audit trail). No server-side logout endpoint needed.
  const startSession = useCallback(async () => {
    const id = crypto.randomUUID();
    setSessionId(id);
    setMessages([]);
    setStage("CONSENT");
    setInput("");
    setBusy(false);
    setHandoff(null);
    setShowAudit(false);
    setAudit([]);
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: id, message: "" }),
    });
    const data = await r.json();
    setMessages([{ role: "assistant", content: data.reply }]);
    setStage(data.stage);
  }, []);

  useEffect(() => {
    startSession();
  }, [startSession]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const text = input.trim();
    if (!text || busy || stage === "RESOLVED" || stage === "ESCALATED") return;
    setInput("");
    setMessages((m) => [...m, { role: "consumer", content: text }]);
    setBusy(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: text }),
      });
      const data = await r.json();
      setMessages((m) => [...m, { role: "assistant", content: data.reply }]);
      setStage(data.stage);
      if (data.handoff) setHandoff(data.handoff);
    } finally {
      setBusy(false);
    }
  }

  async function loadAudit() {
    const r = await fetch(`/api/audit?sessionId=${sessionId}`);
    const data = await r.json();
    setAudit(data.events ?? []);
    setShowAudit(true);
  }

  const terminal = stage === "RESOLVED" || stage === "ESCALATED";
  const active = stepIndex(stage);
  // Past the AUTH step the consumer is verified; the control becomes a "Log out".
  const authenticated = stage !== "CONSENT" && stage !== "AUTH";

  function resetSession() {
    if (
      authenticated &&
      !window.confirm("Log out and end this session? Your verified session will be cleared.")
    ) {
      return;
    }
    startSession();
  }

  return (
    <main className="mx-auto flex h-dvh max-w-3xl flex-col overflow-hidden px-4 py-6">
      {/* Header */}
      <header className="mb-4 flex-none">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Meridian Recovery Services</h1>
            <p className="text-sm text-slate-500">Secure account resolution assistant</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={loadAudit}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              View audit log
            </button>
            <button
              onClick={resetSession}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                authenticated
                  ? "border-rose-300 bg-white text-rose-600 hover:bg-rose-50"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
              }`}
            >
              {authenticated ? "Log out" : "New session"}
            </button>
          </div>
        </div>

        {/* Stage indicator */}
        <div className="mt-4 flex items-center gap-2">
          {STEPS.map((step, i) => {
            const done = active > i || (terminal && i < 3);
            const isActive = active === i;
            return (
              <div key={step.key} className="flex flex-1 items-center gap-2">
                <div
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold ${
                    isActive ? "bg-indigo-600 text-white" : done ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"
                  }`}
                >
                  {done && !isActive ? "✓" : i + 1}
                </div>
                <span className={`text-xs ${isActive ? "font-semibold text-indigo-700" : "text-slate-500"}`}>{step.label}</span>
                {i < STEPS.length - 1 && <div className={`h-px flex-1 ${done ? "bg-emerald-400" : "bg-slate-200"}`} />}
              </div>
            );
          })}
        </div>
        {terminal && (
          <div
            className={`mt-3 rounded-md px-3 py-2 text-sm font-medium ${
              stage === "RESOLVED" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
            }`}
          >
            {stage === "RESOLVED" ? "✓ Account resolved" : "→ Transferring you to a specialist"}
          </div>
        )}
      </header>

      {/* Chat */}
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "consumer" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                m.role === "consumer"
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-800"
              }`}
            >
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl bg-slate-100 px-4 py-2.5 text-sm text-slate-400">…</div>
          </div>
        )}
      </div>

      {/* Handoff package */}
      {handoff && (
        <div className="mt-3 flex-none rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <div className="mb-1 font-semibold">Handoff package (stubbed delivery)</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(handoff, null, 2)}</pre>
        </div>
      )}

      {/* Input */}
      <div className="mt-3 flex flex-none gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={busy || terminal}
          placeholder={terminal ? "This session has concluded." : "Type your message…"}
          className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50"
        />
        <button
          onClick={send}
          disabled={busy || terminal || !input.trim()}
          className="rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
        >
          Send
        </button>
      </div>

      {/* Audit modal */}
      {showAudit && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowAudit(false)}>
          <div className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold text-slate-800">Audit log — compliance evidence chain</h2>
              <button onClick={() => setShowAudit(false)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            {audit.length === 0 ? (
              <p className="text-sm text-slate-500">No events yet.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="py-1 pr-2">Event</th>
                    <th className="py-1 pr-2">State</th>
                    <th className="py-1 pr-2">Detail</th>
                    <th className="py-1">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((e, i) => (
                    <tr key={i} className="border-b border-slate-100 align-top">
                      <td className="py-1 pr-2 font-medium text-slate-700">{String(e.event)}</td>
                      <td className="py-1 pr-2 text-slate-500">{String(e.fsmStateAtEvent ?? "")}</td>
                      <td className="py-1 pr-2 text-slate-500">{e.detail ? JSON.stringify(e.detail) : ""}</td>
                      <td className="py-1 text-slate-500">{String(e.reason ?? "")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
