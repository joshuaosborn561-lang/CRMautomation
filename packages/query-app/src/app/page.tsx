"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ReviewItem {
  id: string;
  source: string;
  created_at: string;
  contact: { email?: string; first_name?: string; last_name?: string; company?: string };
  deal: { title: string; stage: string; stage_reason: string };
  note: { summary: string; sentiment: string };
  task?: { title: string; description: string };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"query" | "review">("query");
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [reviewLoading, setReviewLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (tab === "review") loadReviews();
  }, [tab]);

  async function loadReviews() {
    setReviewLoading(true);
    try {
      const res = await fetch("/api/review");
      const data = await res.json();
      setReviews(data.reviews || []);
    } catch {
      setReviews([]);
    }
    setReviewLoading(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || loading) return;

    const question = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: question }]);
    setLoading(true);

    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer || data.error || "No response" },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to reach the server." },
      ]);
    }
    setLoading(false);
  }

  async function handleReviewAction(id: string, action: "approve" | "reject") {
    try {
      await fetch(`/api/review/${id}/${action}`, { method: "POST" });
      setReviews((prev) => prev.filter((r) => r.id !== id));
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "2rem 1rem" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>CRM Autopilot</h1>
      <p style={{ color: "#888", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
        Ask questions about your pipeline or review pending CRM updates
      </p>

      {/* Tabs */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1.5rem" }}>
        <button
          onClick={() => setTab("query")}
          style={{
            padding: "0.5rem 1rem",
            background: tab === "query" ? "#333" : "transparent",
            color: tab === "query" ? "#fff" : "#888",
            border: "1px solid #333",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Pipeline Q&A
        </button>
        <button
          onClick={() => setTab("review")}
          style={{
            padding: "0.5rem 1rem",
            background: tab === "review" ? "#333" : "transparent",
            color: tab === "review" ? "#fff" : "#888",
            border: "1px solid #333",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Review Queue {reviews.length > 0 && `(${reviews.length})`}
        </button>
      </div>

      {/* Query Tab */}
      {tab === "query" && (
        <>
          <div
            style={{
              minHeight: 400,
              maxHeight: 500,
              overflowY: "auto",
              marginBottom: "1rem",
              padding: "1rem",
              border: "1px solid #222",
              borderRadius: 8,
              background: "#111",
            }}
          >
            {messages.length === 0 && (
              <div style={{ color: "#555", textAlign: "center", marginTop: "8rem" }}>
                <p>Ask me anything about your pipeline.</p>
                <p style={{ fontSize: "0.85rem" }}>
                  Try: &quot;What deals haven&apos;t had activity in 2 weeks?&quot;
                </p>
              </div>
            )}
            {messages.map((msg, i) => (
              <div
                key={i}
                style={{
                  marginBottom: "1rem",
                  textAlign: msg.role === "user" ? "right" : "left",
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    maxWidth: "80%",
                    padding: "0.75rem 1rem",
                    borderRadius: 12,
                    background: msg.role === "user" ? "#2563eb" : "#1e1e1e",
                    color: "#ededed",
                    whiteSpace: "pre-wrap",
                    textAlign: "left",
                    fontSize: "0.9rem",
                    lineHeight: 1.5,
                  }}
                >
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ color: "#888", fontStyle: "italic" }}>Thinking...</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <form onSubmit={handleSubmit} style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about your pipeline..."
              style={{
                flex: 1,
                padding: "0.75rem 1rem",
                border: "1px solid #333",
                borderRadius: 8,
                background: "#111",
                color: "#ededed",
                fontSize: "0.9rem",
                outline: "none",
              }}
            />
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: "0.75rem 1.5rem",
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                cursor: loading ? "wait" : "pointer",
                fontSize: "0.9rem",
              }}
            >
              Ask
            </button>
          </form>
        </>
      )}

      {/* Review Tab */}
      {tab === "review" && (
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1rem",
            }}
          >
            <span style={{ color: "#888" }}>
              {reviews.length} pending review{reviews.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={loadReviews}
              style={{
                padding: "0.25rem 0.75rem",
                background: "#222",
                color: "#888",
                border: "1px solid #333",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              Refresh
            </button>
          </div>

          {reviewLoading && <p style={{ color: "#888" }}>Loading...</p>}

          {reviews.map((review) => (
            <div
              key={review.id}
              style={{
                marginBottom: "1rem",
                padding: "1rem",
                border: "1px solid #222",
                borderRadius: 8,
                background: "#111",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "0.5rem",
                }}
              >
                <span
                  style={{
                    fontSize: "0.75rem",
                    color: "#888",
                    textTransform: "uppercase",
                  }}
                >
                  {review.source}
                </span>
                <span style={{ fontSize: "0.75rem", color: "#888" }}>
                  {new Date(review.created_at).toLocaleString()}
                </span>
              </div>

              <h3 style={{ margin: "0 0 0.25rem", fontSize: "1rem" }}>
                {review.deal.title}
              </h3>
              <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "#aaa" }}>
                {review.contact.email} &middot; Stage: {review.deal.stage}
              </p>
              <p
                style={{
                  margin: "0 0 0.5rem",
                  fontSize: "0.85rem",
                  color: "#ccc",
                  lineHeight: 1.4,
                }}
              >
                {review.note.summary}
              </p>
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#888" }}>
                Reason: {review.deal.stage_reason}
              </p>

              {review.task && (
                <p
                  style={{
                    margin: "0 0 0.75rem",
                    fontSize: "0.8rem",
                    color: "#f59e0b",
                  }}
                >
                  Task: {review.task.title}
                </p>
              )}

              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  onClick={() => handleReviewAction(review.id, "approve")}
                  style={{
                    padding: "0.4rem 1rem",
                    background: "#16a34a",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Approve
                </button>
                <button
                  onClick={() => handleReviewAction(review.id, "reject")}
                  style={{
                    padding: "0.4rem 1rem",
                    background: "#dc2626",
                    color: "#fff",
                    border: "none",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}

          {!reviewLoading && reviews.length === 0 && (
            <p style={{ color: "#555", textAlign: "center", marginTop: "3rem" }}>
              No pending reviews. All caught up!
            </p>
          )}
        </div>
      )}
    </div>
  );
}
