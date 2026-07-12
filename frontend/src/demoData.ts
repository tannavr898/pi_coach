// Canned data for the marketing demo (`/demo`). Nothing here hits the API — it
// drives the real screens with a realistic worked example so visitors (and ad
// screenshots) can see exactly what PI Coach produces, without a live session.
//
// The `evidence` quotes below are EXACT substrings of DEMO_RESPONSE /
// DEMO_FOLLOWUP so the transcript highlighter lights them up just like a real
// graded run. Keep them in sync if you edit the response text. The criteria ids,
// names, and definitions match our framework (backend/app/data/framework.json).

import type {
  DeliveryMetrics,
  ScenarioResponse,
  ScoreResponse,
} from "./api";

export const DEMO_RESPONSE = `Good afternoon, and thanks for bringing me in. As FreshBlend's marketing consultant, my recommendation is to launch a tiered mobile loyalty program paired with a tighter promotional mix, and I will walk you through how each piece grows repeat visits.

First, on building customer relationships: loyalty is not just a punch card, it is how we use customer data to make regulars feel known. I would capture purchase history in the app and trigger a free smoothie reward every tenth visit, plus a birthday offer. That turns a one-time buyer into a habit.

On the promotional mix, I would shift spend away from untargeted radio and toward app push notifications and local micro-influencers, because our 18 to 28 core lives on their phones. A 3 to 5pm power hour discount fills our slowest window without cutting into peak traffic.

For distribution, the app becomes our owned channel, so we stop renting attention from third parties and reach customers directly at full margin. That also gives us first-party data the delivery apps never hand back.

Finally, on brand: every touchpoint should feel fresh, fast, and local. I would keep the visual identity consistent from the cup to the app icon so we are instantly recognizable.

To measure success I would track repeat-visit rate and reward redemption monthly, aiming for a 15 percent lift in returning customers within two quarters. I would pilot in three stores first to prove it before a full rollout.`;

export const DEMO_FOLLOWUP = `Great question. The biggest risk is reward costs eating into margin, so I would cap the free smoothie at every tenth paid visit and model the breakeven before launch, expecting the higher repeat rate to more than cover it. If redemption ran ahead of new revenue in the pilot, I would lengthen the earn cycle rather than scrap the program.`;

export const DEMO_SCENARIO: ScenarioResponse = {
  topic: "Marketing plan to grow repeat visits at a smoothie chain",
  industry: "food service",
  event: "Food Marketing",
  event_kind: "individual",
  quantitative: false,
  team: false,
  timing: { prep_seconds: 600, present_seconds: 600, target_seconds: 450 },
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
      id: "FW-177",
      domain: "Marketing",
      topic: "Place",
      name: "Distribution and Channel Strategy",
      definition:
        "Does the response think about how the product reaches customers, the places and channels, and choose ones that fit the customer and offer?",
      strong_looks_like:
        "Chooses where and how customers get the product to match their habits and the offer, weighing each channel's trade-offs.",
      weak_looks_like:
        "Ignores how the product reaches the customer; a channel that doesn't fit how the target actually buys.",
      coaches: "Getting the product to customers through the right channels",
    },
    {
      id: "FW-164",
      domain: "Marketing",
      topic: "Brand",
      name: "Branding and Brand Identity",
      definition:
        "Does the response build a clear, consistent identity for the business, what it stands for and how it presents, rather than leaving the brand accidental?",
      strong_looks_like:
        "Articulates what the business stands for and keeps decisions consistent with that identity.",
      weak_looks_like: "No coherent identity; inconsistent presentation; the brand is whatever happens by accident.",
      coaches: "Building a clear, consistent brand",
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
    "You have up to 10 minutes to review the situation and prepare. You may make notes to use during your presentation.",
    "You then have up to 10 minutes to present to the judge.",
    "You are evaluated on your solution and how well you demonstrate the business skills listed for this role-play.",
    "The judge will ask you follow-up questions after your presentation.",
  ],
  situation: `You are a marketing consultant brought in by FreshBlend, a regional chain of nine smoothie and juice bars in a mid-sized metro area. FreshBlend has loyal weekday-morning regulars but its afternoons are quiet, and management has noticed that many first-time customers never come back.

The owner, Dana Okafor, wants a plan to turn more one-time buyers into repeat customers and to lift traffic in the slow 3-to-5pm window, without simply slashing prices across the board. Dana cares about the brand feeling fresh and local, and is open to using the FreshBlend mobile app more aggressively.

You will present your recommendation to Dana, who will play the role of the owner and ask you two follow-up questions at the end.`,
  followup_questions: [
    "A tiered loyalty program adds operating cost. How would you make sure the rewards don't erode the margin you're trying to protect?",
    "If the three-store pilot showed only a small lift in repeat visits, how would you decide whether to roll out, adjust, or stop?",
  ],
};

export const DEMO_SCORE: ScoreResponse = {
  total_points: 37,
  max_points: 50,
  // Final weighted score: 74% indicators × 0.60 + 92.5% analysis × 0.25 + 84% present × 0.15 = 80.1.
  overall_percent: 80,
  overall_level: "proficient",
  pi_section_score: 2.96,
  pi_section_percent: 74,
  analytical: {
    weight: 0.25,
    framing: {
      score: 3,
      justification:
        "Clearly frames the real problem, turning one-time buyers into repeat visits and filling the slow afternoon window, and names the target audience.",
      evidence: "our 18 to 28 core lives on their phones",
    },
    solution_quality: {
      score: 4,
      justification:
        "A realistic, organized loyalty-plus-promotion plan that respects the owner's constraints and de-risks with a three-store pilot before rollout.",
      evidence: "I would pilot in three stores first to prove it before a full rollout",
    },
    pi_application: {
      score: 3,
      justification:
        "The assessed skills genuinely drive the recommendation rather than sitting beside it, though the brand thread stays thin.",
      evidence: "the app becomes our owned channel",
    },
    creativity: {
      bonus: 0.25,
      justification:
        "The '3 to 5pm power hour' is a memorable, apt framing that makes the off-peak tactic instantly clear and sellable to the owner.",
      evidence: "A 3 to 5pm power hour discount fills our slowest window",
    },
    core_score: 3.45,
    section_score: 3.7,
    section_percent: 92.5,
  },
  presentation: {
    weight: 0.15,
    section_score: 3.36,
    section_percent: 84,
    notes:
      "Steady 129 WPM with only six fillers reads as conversational, not memorized, and the follow-up answer stayed composed and specific.",
  },
  final: {
    percent: 80.1,
    top_strength:
      "A realistic, well-sequenced solution: loyalty program, targeted promo, and a pilot to prove it before rollout.",
    biggest_weakness:
      "Brand is treated as look-and-feel, so the indicator score and the persuasive core both leave points on the table.",
    one_key_fix:
      "State what FreshBlend stands for and tie the loyalty rewards back to that promise, then link the tactics to the 15% target.",
  },
  summary:
    "A clear, well-organized recommendation that ties a mobile loyalty program to every assigned skill and lands a sensible pilot-first plan. The thinking is strong on customer relationships and channel; it leaves points on the table on brand and on proving the solution will actually move the numbers.",
  strengths: [
    "Opened with the recommendation, then structured the pitch around each skill.",
    "Named a concrete success metric and a low-risk pilot.",
    "Connected the app to first-party data, not just convenience.",
  ],
  improvements: [
    "Develop the brand point beyond visual consistency: what does FreshBlend stand for?",
    "Quantify the expected impact, not just the metric you'd watch.",
    "Tie the 15% target back to why the tactics should produce it.",
  ],
  followup_feedback:
    "Handled the margin question well: capping rewards at paid visits and modeling breakeven shows real business judgment, and the fallback to lengthen the earn cycle is a thoughtful contingency.",
  math_checks: [],
  scores: [
    {
      criterion_id: "FW-041",
      name: "Customer Relationship Thinking",
      domain: "Customer Relations",
      topic: "Relationships",
      level: "proficient",
      points: 8,
      max_points: 10,
      headline: "Used data to drive retention",
      feedback:
        "You moved past the textbook line and showed **how data drives loyalty**, capturing purchase history and rewarding repeat visits. To reach exemplary, tie it to a **retention number** you'd expect to move.",
      evidence: ["capture purchase history in the app and trigger a free smoothie reward every tenth visit"],
      gaps: ["No retention rate or churn figure named", "Didn't distinguish regulars vs. new buyers"],
      suggestion: "I'd segment first-time vs. returning customers and target a repeat-visit rate lift from 22% to 30% this quarter.",
    },
    {
      criterion_id: "FW-168",
      name: "Promotional Strategy",
      domain: "Marketing",
      topic: "Promotion",
      level: "proficient",
      points: 8,
      max_points: 10,
      headline: "Picked a coherent, audience-fit blend",
      feedback:
        "Good reasoning for **shifting spend from radio to app push and micro-influencers** based on where the 18–28 core actually is. You named the channels but didn't fully explain the **trade-offs** between them.",
      evidence: ["shift spend away from untargeted radio and toward app push notifications and local micro-influencers"],
      gaps: ["Didn't weigh the cost of influencers vs. push", "No budget split across the channels"],
      suggestion: "I'd put 60% of the budget into app push since it's near-free per send, and 40% into two local micro-influencers to drive trial.",
    },
    {
      criterion_id: "FW-177",
      name: "Distribution and Channel Strategy",
      domain: "Marketing",
      topic: "Place",
      level: "proficient",
      points: 8,
      max_points: 10,
      headline: "Framed the app as an owned channel",
      feedback:
        "Strong insight that **the app becomes an owned channel** and returns first-party data the delivery apps withhold. That's the systems thinking judges reward, one step short of comparing it to the delivery channel on cost.",
      evidence: ["the app becomes our owned channel", "first-party data the delivery apps never hand back"],
      gaps: ["No comparison to the third-party delivery channel's economics"],
      suggestion: "Delivery apps take 20–30% per order, so shifting even a quarter of those sales to our own app protects real margin.",
    },
    {
      criterion_id: "FW-164",
      name: "Branding and Brand Identity",
      domain: "Marketing",
      topic: "Brand",
      level: "developing",
      points: 5,
      max_points: 10,
      headline: "Stayed at look-and-feel, not meaning",
      feedback:
        "You kept the **visual identity consistent**, which is real, but brand is mostly treated as a logo here. Push into what FreshBlend **stands for**, the promise that earns loyalty, to lift this above developing.",
      evidence: ["keep the visual identity consistent from the cup to the app icon"],
      gaps: ["No brand promise or positioning stated", "Didn't connect brand to the loyalty program"],
      suggestion: "FreshBlend should stand for 'fresh, fast, and local,' and the loyalty rewards should reinforce that, like a free local-fruit add-on.",
    },
    {
      criterion_id: "FW-280",
      name: "Measuring Success and Follow-Through",
      domain: "Strategic Management",
      topic: "Measurement",
      level: "proficient",
      points: 8,
      max_points: 10,
      headline: "Named a real target and a pilot",
      feedback:
        "You named a real target, a **15 percent lift in returning customers**, and a pilot to prove it, which is more than most do. To reach exemplary, show **why the tactics should produce that lift**, not just that you'd measure it.",
      evidence: ["track repeat-visit rate and reward redemption monthly, aiming for a 15 percent lift"],
      gaps: ["No link from tactics to the 15% number"],
      suggestion: "If the loyalty program converts even 1 in 5 first-timers into regulars, that alone gets us most of the way to the 15% lift.",
    },
  ],
};

export const DEMO_DELIVERY: DeliveryMetrics = {
  duration_seconds: 472,
  word_count: 1015,
  pace_wpm: 129,
  pace_flag: "good",
  filler_count: 6,
  filler_per_min: 0.8,
  fillers: [
    { word: "um", count: 3 },
    { word: "like", count: 2 },
    { word: "you know", count: 1 },
  ],
  crutch_phrases: [{ phrase: "kind of", count: 2 }],
  pause_count: 11,
  long_pauses: [{ at_seconds: 188, length_seconds: 4 }],
  longest_pause_seconds: 4,
  time_used_seconds: 472,
  time_target_seconds: 450,
  time_flag: "good",
  reading_signal: false,
  notes: [
    "Pace sat in the ideal 120–150 WPM range, easy for a judge to follow.",
    "Only 6 fillers across nearly 8 minutes; the one 4-second pause came right before your channel point, which actually read as a deliberate beat.",
    "You used 7:52 of the window, leaving room for the follow-up, which is well managed.",
  ],
  delivery_score: 84,
  delivery_components: [
    { label: "Pace", score: 100, hint: "In the 130–160 WPM range" },
    { label: "Fluency", score: 90, hint: "Few filler words" },
    { label: "Flow", score: 80, hint: "One long pause" },
    { label: "Timing", score: 100, hint: "Used the window well" },
  ],
  speakers: [],
  dominated_by: "",
  balance_note: "",
};
