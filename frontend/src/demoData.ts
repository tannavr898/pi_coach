// Canned data for the marketing demo (`/demo`). Nothing here hits the API — it
// drives the real screens with a realistic worked example so visitors (and ad
// screenshots) can see exactly what PI Coach produces, without a live session.
//
// The `evidence` quotes below are EXACT substrings of DEMO_RESPONSE /
// DEMO_FOLLOWUP so the transcript highlighter lights them up just like a real
// graded run. Keep them in sync if you edit the response text.

import type {
  DeliveryMetrics,
  ScenarioResponse,
  ScoreResponse,
} from "./api";

export const DEMO_RESPONSE = `Good afternoon, and thanks for bringing me in. As FreshBlend's marketing consultant, my recommendation is to launch a tiered mobile loyalty program paired with a tighter promotional mix, and I will walk you through how each piece grows repeat visits.

First, on customer relationship management: loyalty is not just a punch card, it is how we use customer data to make regulars feel known. I would capture purchase history in the app and trigger a free smoothie reward every tenth visit, plus a birthday offer. That turns a one-time buyer into a habit.

On the promotional mix, I would shift spend away from untargeted radio and toward app push notifications and local micro-influencers, because our 18 to 28 core lives on their phones. A 3 to 5pm power hour discount fills our slowest window without cutting into peak traffic.

For channel management, the app becomes our owned channel, so we stop renting attention from third parties and reach customers directly at full margin. That also gives us first-party data the delivery apps never hand back.

Finally, on brand: every touchpoint should feel fresh, fast, and local. I would keep the visual identity consistent from the cup to the app icon so we are instantly recognizable.

To measure success I would track repeat-visit rate and reward redemption monthly, aiming for a 15 percent lift in returning customers within two quarters. I would pilot in three stores first to prove it before a full rollout.`;

export const DEMO_FOLLOWUP = `Great question. The biggest risk is reward costs eating into margin, so I would cap the free smoothie at every tenth paid visit and model the breakeven before launch, expecting the higher repeat rate to more than cover it. If redemption ran ahead of new revenue in the pilot, I would lengthen the earn cycle rather than scrap the program.`;

export const DEMO_SCENARIO: ScenarioResponse = {
  event: {
    code: "PMK",
    name: "Principles of Marketing",
    level: "PQ",
    pi_count: 4,
    cluster_label: "Marketing",
  },
  level: "district",
  instructional_area: "Customer Relations / Marketing-Information Management",
  performance_indicators: [
    {
      id: "CRM:001",
      text: "Explain the role of customer relationship management in retaining customers.",
      area: "CRM",
      area_name: "Customer Relations",
      level: "PQ",
      definition:
        "Using customer data and personalized contact to build loyalty and repeat business.",
    },
    {
      id: "PRO:002",
      text: "Explain the components of the promotional mix and select an appropriate blend.",
      area: "PRO",
      area_name: "Promotion",
      level: "PQ",
      definition:
        "Advertising, sales promotion, personal selling, and digital/social as a coordinated set.",
    },
    {
      id: "CM:008",
      text: "Describe the use of channels of distribution to reach the customer.",
      area: "CM",
      area_name: "Channel Management",
      level: "PQ",
      definition: "The paths a product or service takes from the business to the end customer.",
    },
    {
      id: "PR:013",
      text: "Explain the role of brand in building customer relationships.",
      area: "PR",
      area_name: "Product/Service Management",
      level: "PQ",
      definition: "The promise and identity that makes a business recognizable and trusted.",
    },
  ],
  solution_criteria: [
    { key: "unique", label: "Unique", desc: "an original, creative approach", max_points: 8 },
    { key: "practical", label: "Practical", desc: "realistic and feasible to execute", max_points: 8 },
    { key: "effective", label: "Effective", desc: "actually solves the stated problem", max_points: 8 },
  ],
  career_competencies: [
    { key: "critical_thinking", label: "Critical Thinking", desc: "sound reasoning and analysis", max_points: 6 },
    { key: "communication", label: "Communication", desc: "clear, organized delivery of ideas", max_points: 6 },
    { key: "decision_making", label: "Decision Making", desc: "justified, well-weighed choices", max_points: 6 },
  ],
  procedures: [
    "You have up to 10 minutes to review this situation and prepare your response.",
    "You will have up to 10 minutes to present to the judge and answer the judge's questions.",
    "You may make notes during prep and refer to them while you present.",
    "Turn in all materials to the judge when you have finished.",
  ],
  situation: `You are a marketing consultant brought in by FreshBlend, a regional chain of nine smoothie and juice bars in a mid-sized metro area. FreshBlend has loyal weekday-morning regulars but its afternoons are quiet, and management has noticed that many first-time customers never come back.

The owner, Dana Okafor, wants a plan to turn more one-time buyers into repeat customers and to lift traffic in the slow 3-to-5pm window — without simply slashing prices across the board. Dana cares about the brand feeling fresh and local, and is open to using the FreshBlend mobile app more aggressively.

You will present your recommendation to Dana, who will play the role of the owner and ask you two follow-up questions at the end.`,
  followup_questions: [
    "A tiered loyalty program adds operating cost. How would you make sure the rewards don't erode the margin you're trying to protect?",
    "If the three-store pilot showed only a small lift in repeat visits, how would you decide whether to roll out, adjust, or stop?",
  ],
};

export const DEMO_SCORE: ScoreResponse = {
  total_points: 75,
  max_points: 100,
  summary:
    "A clear, well-organized recommendation that ties a mobile loyalty program to every assigned indicator and lands a sensible pilot-first plan. The thinking is strong on customer relationships and channel; it leaves points on the table on brand and on proving the solution will actually move the numbers.",
  strengths: [
    "Opened with the recommendation, then structured the pitch around each indicator.",
    "Named a concrete success metric and a low-risk pilot.",
    "Connected the app to first-party data, not just convenience.",
  ],
  improvements: [
    "Develop the brand point beyond visual consistency — what does FreshBlend stand for?",
    "Quantify the expected impact, not just the metric you'd watch.",
    "Weigh one alternative you rejected, to show decision-making.",
  ],
  followup_feedback:
    "Handled the margin question well — capping rewards at paid visits and modeling breakeven shows real business judgment, and the fallback to lengthen the earn cycle is a thoughtful contingency.",
  scores: [
    // --- Performance indicators (max 12 each) ---
    {
      key: "pi-crm",
      category: "performance_indicator",
      pi_id: "CRM:001",
      label: "Explain the role of customer relationship management",
      level: "proficient",
      points: 10,
      max_points: 12,
      headline: "Defined CRM and applied it to retention",
      feedback:
        "You moved past the textbook line and showed **how data drives loyalty** — capturing purchase history and rewarding repeat visits. To reach exemplary, tie it to a **retention number** you'd expect to move.",
      evidence: [
        "capture purchase history in the app and trigger a free smoothie reward every tenth visit",
      ],
      gaps: ["No retention rate or churn figure named", "Didn't mention segmenting regulars vs. new buyers"],
    },
    {
      key: "pi-pro",
      category: "performance_indicator",
      pi_id: "PRO:002",
      label: "Explain the components of the promotional mix",
      level: "proficient",
      points: 9,
      max_points: 12,
      headline: "Picked a coherent, audience-fit blend",
      feedback:
        "Good reasoning for **shifting spend from radio to app push and micro-influencers** based on where the 18–28 core actually is. You named the channels but didn't fully explain the **role each one plays** in the mix.",
      evidence: [
        "shift spend away from untargeted radio and toward app push notifications and local micro-influencers",
      ],
      gaps: ["Didn't distinguish advertising vs. sales promotion", "No budget split across the channels"],
    },
    {
      key: "pi-cm",
      category: "performance_indicator",
      pi_id: "CM:008",
      label: "Describe the use of channels of distribution",
      level: "proficient",
      points: 10,
      max_points: 12,
      headline: "Framed the app as an owned channel",
      feedback:
        "Strong insight that **the app becomes an owned channel** and returns first-party data the delivery apps withhold. That's the systems thinking judges reward — one step short of comparing it to the wholesale/delivery channel on cost.",
      evidence: ["the app becomes our owned channel", "first-party data the delivery apps never hand back"],
      gaps: ["No comparison to the third-party delivery channel's economics"],
    },
    {
      key: "pi-brand",
      category: "performance_indicator",
      pi_id: "PR:013",
      label: "Explain the role of brand in building relationships",
      level: "developing",
      points: 7,
      max_points: 12,
      headline: "Stayed at look-and-feel, not meaning",
      feedback:
        "You kept the **visual identity consistent**, which is real, but brand is mostly treated as a logo here. Push into what FreshBlend **promises** customers — the feeling that earns loyalty — to lift this above developing.",
      evidence: ["keep the visual identity consistent from the cup to the app icon"],
      gaps: ["No brand promise or positioning stated", "Didn't connect brand to the loyalty program emotionally"],
    },
    // --- Solution (max 8 each) ---
    {
      key: "sol-unique",
      category: "solution",
      pi_id: null,
      label: "Unique",
      level: "proficient",
      points: 6,
      max_points: 8,
      headline: "Smart slow-window play",
      feedback:
        "The **3-to-5pm power hour** is a creative, targeted fix that protects peak pricing. Solid, though loyalty apps themselves are common — the originality is in the timing, not the tool.",
      evidence: ["3 to 5pm power hour discount fills our slowest window"],
      gaps: ["The loyalty-app idea itself is fairly standard"],
    },
    {
      key: "sol-practical",
      category: "solution",
      pi_id: null,
      label: "Practical",
      level: "proficient",
      points: 7,
      max_points: 8,
      headline: "Pilot-first plan is realistic",
      feedback:
        "Proposing to **pilot in three stores before a full rollout** is exactly the kind of feasible, de-risked execution a real owner would green-light. Very executable on FreshBlend's footprint.",
      evidence: ["pilot in three stores first to prove it before a full rollout"],
      gaps: ["No rough cost or timeline for the pilot"],
    },
    {
      key: "sol-effective",
      category: "solution",
      pi_id: null,
      label: "Effective",
      level: "developing",
      points: 5,
      max_points: 8,
      headline: "Right metric, impact not sized",
      feedback:
        "You named a real target — a **15 percent lift in returning customers** — which is more than most do. It stays developing because you don't show **why the plan should produce that lift**, only that you'd measure it.",
      evidence: ["track repeat-visit rate and reward redemption monthly, aiming for a 15 percent lift"],
      gaps: ["No link from tactics to the 15% number", "Didn't address the afternoon-traffic goal's payoff"],
    },
    // --- Career competencies (max 6 each) ---
    {
      key: "cc-critical",
      category: "career_competency",
      pi_id: null,
      label: "Critical Thinking",
      level: "proficient",
      points: 5,
      max_points: 6,
      headline: "Reasoned from cause to effect",
      feedback:
        "Clear logic that owning the channel means you **stop renting attention and keep full margin** — you explained the why, not just the what.",
      evidence: ["we stop renting attention from third parties and reach customers directly at full margin"],
      gaps: ["Didn't surface a trade-off or risk unprompted"],
    },
    {
      key: "cc-comm",
      category: "career_competency",
      pi_id: null,
      label: "Communication",
      level: "proficient",
      points: 5,
      max_points: 6,
      headline: "Led with the recommendation",
      feedback:
        "Stating **the recommendation up front** and signposting each section makes this easy to follow — judge-friendly structure.",
      evidence: ["my recommendation is to launch a tiered mobile loyalty program"],
      gaps: ["A closing recap would bookend it more strongly"],
    },
    {
      key: "cc-decision",
      category: "career_competency",
      pi_id: null,
      label: "Decision Making",
      level: "developing",
      points: 3,
      max_points: 6,
      headline: "Chose, but didn't weigh alternatives",
      feedback:
        "You committed to a plan and a pilot, which is good, but the decision would look stronger if you **named an option you rejected** and said why the loyalty route won.",
      evidence: ["I would pilot in three stores first"],
      gaps: ["No alternative considered out loud", "Decision criteria left implicit"],
    },
    // --- Overall impression (max 10) ---
    {
      key: "overall",
      category: "overall_impression",
      pi_id: null,
      label: "Overall Impression",
      level: "proficient",
      points: 8,
      max_points: 10,
      headline: "Poised, organized, business-ready",
      feedback:
        "Reads like a **confident, well-prepared consultant** — greeting, clear throughline, and a measurable close. Tightening the brand and impact sections would push this toward exemplary.",
      evidence: [],
      gaps: ["Brand and impact are the two soft spots to firm up"],
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
    "Pace sat in the ideal 120–150 WPM range — easy for a judge to follow.",
    "Only 6 fillers across nearly 8 minutes; the one 4-second pause came right before your channel point, which actually read as a deliberate beat.",
    "You used 7:52 of the window, leaving room for the follow-up — well managed.",
  ],
};
