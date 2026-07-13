// The guided "first rep" scenario. Hardcoded (like demoData.ts) so a brand-new
// visitor can complete a full role-play in ~2 minutes with ZERO scenario-
// generation LLM call — a curious visitor who bounces before submitting costs
// nothing. Grading still runs the real /api/score-content when they finish, so
// the payoff (deep feedback + highlighted transcript) is undiminished.
//
// Deliberately tiny and non-technical: an everyday coffee-cart situation, only
// three easy, general criteria, and a ~75-second speaking target so the first
// ask feels small. The criteria ids/text match backend/app/data/framework.json.

import type { ScenarioResponse } from "./api";

export const ONBOARDING_SCENARIO: ScenarioResponse = {
  topic: "Getting first-time coffee-cart customers to come back",
  industry: "food service",
  event: "Quick Start",
  event_kind: "individual",
  quantitative: false,
  team: false,
  // Short on purpose: 2-minute prep, 2-minute window, ~75s of speaking.
  timing: { prep_seconds: 120, present_seconds: 120, target_seconds: 75 },
  domain_focus: ["Customer Relations", "Marketing"],
  level: "district",
  mode: "learn",
  criteria: [
    {
      id: "FW-041",
      domain: "Customer Relations",
      topic: "Relationships",
      name: "Customer Relationship Thinking",
      definition:
        "Does the response show how the business will identify, keep, and deepen customer relationships over time, rather than treating customers as one-time transactions?",
      strong_looks_like:
        "Uses customer data or loyalty to make customers feel known; distinguishes new versus returning customers; ties retention to a specific mechanism.",
      weak_looks_like:
        "Treats customers as one-time sales; vague 'good service' with no mechanism; no retention thinking at all.",
      coaches: "Building and sustaining customer relationships over time",
    },
    {
      id: "FW-168",
      domain: "Marketing",
      topic: "Promotion",
      name: "Promotional Strategy",
      definition:
        "Does the response choose a deliberate, audience-appropriate mix of ways to reach customers and justify why that blend fits THIS business, rather than defaulting to 'advertise more'?",
      strong_looks_like: "Names specific channels, matches them to the target audience, and explains the trade-offs.",
      weak_looks_like: "Generic 'we'll market it'; channels with no audience rationale.",
      coaches: "Choosing a coherent, audience-fit promotional mix",
    },
    {
      id: "FW-280",
      domain: "Strategic Management",
      topic: "Measurement",
      name: "Measuring Success and Follow-Through",
      definition:
        "Does the response define how it will know whether the plan worked, a concrete measure, and follow through, rather than leaving 'success' undefined?",
      strong_looks_like:
        "Names a specific, measurable indicator of success and how it would be tracked, and plans to adjust from it.",
      weak_looks_like: "No way to tell if the plan worked; 'it'll be a success' with no metric; no follow-up on the result.",
      coaches: "Defining and tracking what success looks like",
    },
  ],
  procedures: [
    "Take a couple of minutes to look over the situation and jot down a few notes.",
    "Then give a short spoken (or typed) recommendation — about 60–90 seconds is plenty.",
    "You're judged on your ideas and, if you speak, on your delivery (pace, fillers, pauses).",
    "The owner will ask you one quick follow-up question at the end.",
  ],
  situation: `Your friend Maya runs a small coffee cart parked outside the local gym on weekday mornings. Business is okay at the 7-to-9am rush, but she's noticed two things: most people who buy once never come back, and her afternoons are completely dead.

Maya knows you've been learning about business, so she asks for your quick advice: how could she get more first-time buyers to become regulars, and how could she bring in customers beyond the morning rush — without just cutting her prices?

Give Maya a short, friendly recommendation. You don't need a full plan — just a few clear, practical ideas she could actually try.`,
  followup_questions: [
    "Nice ideas. Of everything you suggested, what's the one thing you'd have Maya try first, and how would she know within a couple of weeks whether it's working?",
  ],
};
