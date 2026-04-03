"use strict";
// ============================================================
// CRM Autopilot - Shared Types & Constants
// ============================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_SOURCES = exports.DEAL_STAGE_LABELS = exports.DEAL_STAGES = void 0;
// --- Deal Stages ---
exports.DEAL_STAGES = [
    "replied_showed_interest",
    "call_meeting_booked",
    "discovery_completed",
    "proposal_sent",
    "negotiating",
    "closed_won",
    "closed_lost",
    "nurture",
];
exports.DEAL_STAGE_LABELS = {
    replied_showed_interest: "Replied / Showed Interest",
    call_meeting_booked: "Call or Meeting Booked",
    discovery_completed: "Discovery Completed",
    proposal_sent: "Proposal Sent",
    negotiating: "Negotiating",
    closed_won: "Closed Won",
    closed_lost: "Closed Lost",
    nurture: "Nurture",
};
// --- Event Sources ---
exports.EVENT_SOURCES = [
    "smartlead",
    "heyreach",
    "zoom_phone",
    "zoom_meeting",
    "gmail",
];
