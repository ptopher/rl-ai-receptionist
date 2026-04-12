// ===== config.js =====
// All business-specific data for RL Small Engines.
// To reuse server.js for another client, duplicate this file and change these values.

module.exports = {

  // ===== BUSINESS IDENTITY =====
  businessName: 'RL Small Engines',
  homepageText: 'RL AI Receptionist is running',
  welcomeGreeting: 'Thanks for calling RL Small Engines. I can help with scheduling, checking your service area, or whether we work on your equipment. Briefly tell me what you need.',
  testEmailTo: 'christopher@rlsmallengines.com',
  testAddress: '1748 Old Georgetown Court Severn Maryland 21144',

  // ===== SYSTEM PROMPT (AI persona + rules) =====
  systemPrompt: `
You are Emma, the phone assistant for RL Small Engines.

Speak naturally, like a real person — not robotic.

CORE BEHAVIOR:
- Keep control of the conversation.
- Ask ONE question at a time.
- Move the call forward quickly.

INTAKE RULES:
- If the caller says common terms like "mower", "lawn mower", "riding mower", "generator", or "pressure washer", assume the machine is correctly identified and DO NOT ask again.
- Do not ask "what type of machine" if it is obvious from the first sentence.
- Move forward immediately once the machine is reasonably clear.
SMART FOLLOW-UP (IMPORTANT):
- NEVER say "tell me more about that".
- Instead:
  1. Briefly acknowledge what they said
  2. Ask ONE useful question to move forward

Examples:
- "Got it — riding mower not starting. When was the last time it ran?"
- "Okay — sounds like it shut off. Does it crank or completely dead?"

RAMBLING CONTROL:
- If the caller talks too much, politely interrupt and guide:
  Example:
  "Got it — sounds like it's not starting. Let me ask you this — when was the last time it ran?"

BUSINESS RULES:
- RL Small Engines is mobile service only — no drop-off.
- Pricing depends on the issue — do not give exact prices.
- Keep callbacks to a minimum.

FLOW RULES:
- Always get ZIP before scheduling.
- If outside service area → politely stop scheduling.
- Offer up to 3 real appointment options.
- Never promise squeeze-ins or callback openings.

GOAL:
Move the call forward efficiently while sounding natural and helpful.
`,

  // ===== ROUTING / SCHEDULING =====
  routingConfig: {
    homeZip: '20724',

    fridayAllowedCounties: ['Anne Arundel', 'Howard'],
    saturdayAllowedCounties: ['Howard', "Prince George's"],

    mondayThursdayWindow: '10:00 to 10:30',
    fridaySaturdayMorningWindow: '10:00 to 12:00',
    fridaySaturdayAfternoonWindow: '1:00 to 4:00',

    mondayThursdayMax: 1,
    fridaySaturdayMorningMax: 2,
    fridaySaturdayAfternoonMax: 3
  },

  // ===== EMAIL SETTINGS (Resend) =====
  resendApiKey: process.env.RESEND_API_KEY || 're_LEfu6Sqh_3J3g6SadCX1gNMFVbmkxXxAe',
  resendFrom: process.env.RESEND_FROM || 'RL Small Engines <christopher@rlsmallengines.com>',

  // Email HTML builder — receives { name, machine, issue, readableDate, serviceWindow, address }
  buildConfirmationEmailHtml({ name, machine, issue, readableDate, serviceWindow, address, xmlEscape }) {
    return `
    <div style="font-family: Arial, sans-serif; color: #111111; line-height: 1.5;">
      <p>Hello ${xmlEscape(name || 'Customer')},</p>
      <p>Your appointment with <strong>RL Small Engines</strong> has been confirmed.</p>
      <p>
        <strong>Service:</strong> ${xmlEscape(machine || 'Unknown')}<br/>
        <strong>Issue:</strong> ${xmlEscape(issue || 'Unknown')}<br/>
        <strong>Date:</strong> ${xmlEscape(readableDate || '')}<br/>
        <strong>Time Window:</strong> ${xmlEscape(serviceWindow || '')}<br/>
        <strong>Address:</strong> ${xmlEscape(address || '')}
      </p>
      <p>Thank you,<br/>RL Small Engines</p>
    </div>
  `;
  },

  // Email subject builder
  buildConfirmationEmailSubject(readableDate) {
    return `RL Small Engines Appointment Confirmation - ${readableDate}`;
  },

  // ===== COUNTY ZIP MAPS =====
  countyZips: {
    "Prince George's": [
      '20707', '20705', '20708', '20783', '20742', '20771', '20769', '20706',
      '20737', '20782', '20781', '20784', '20720', '20715', '20721', '20716',
      '20785', '20743', '20747', '20746', '20774', '20748', '20745', '20735',
      '20772', '20623', '20744', '20607', '20613'
    ],
    "Howard": [
      '20701', '21029', '21044', '21045', '21046', '21075', '20759',
      '21076', '20777', '20794', '20723', '21042', '21043'
    ],
    "Anne Arundel": [
      '21401', '21402', '21403', '21012', '21114', '21032', '21035',
      '21037', '21054', '21060', '21061', '21076', '21077', '20776',
      '20794', '20724', '21090', '21108', '21113', '21122', '21140',
      '21144', '21146'
    ],
    "Baltimore County": [
      '21228', '21043', '21227', '21208', '21133', '21136', '21244', '21163'
    ]
  },

  // ===== LOCAL SPEECH CORRECTION LAYER =====
  exactPhraseCorrections: [
    ['bevern', 'severn'],
    ['saverne', 'severn'],
    ['savern', 'severn'],
    ['saverne maryland', 'severn maryland'],
    ['savern maryland', 'severn maryland'],
    ['seven maryland', 'severn maryland'],
    ['7 maryland', 'severn maryland'],
    ['severn marylin', 'severn maryland'],
    ['stubborn maryland', 'severn maryland'],
    ['stubbern maryland', 'severn maryland'],
    ['odenton marylin', 'odenton maryland'],
    ['glen bernie', 'glen burnie'],
    ['glen berny', 'glen burnie'],
    ['glenn burnie', 'glen burnie'],
    ['bowy', 'bowie'],
    ['booie', 'bowie'],
    ['bui', 'bowie'],
    ['lanhamm', 'lanham'],
    ['lanem', 'lanham'],
    ['croftonn', 'crofton'],
    ['millersvile', 'millersville'],
    ['pasadenaa', 'pasadena'],
    ['gambrillss', 'gambrills'],
    ['laurel marylin', 'laurel maryland'],
    ['bel air road', 'belair road'],
    ['belair rd', 'belair road'],
    ['ain arundel', 'anne arundel'],
    ['anne arundele', 'anne arundel'],
    ['lawn tractor', 'riding mower'],
    ['ride on mower', 'riding mower'],
    ['rider mower', 'riding mower'],
    ['push mower', 'lawnmower'],
    ['pressure washing machine', 'pressure washer'],
    ['snow blower', 'snowblower']
  ],

  wordCorrections: {
    bevern: 'severn',
    saverne: 'severn',
    savern: 'severn',
    sevenn: 'severn',
    severnn: 'severn',
    stubborn: 'severn',
    stubbern: 'severn',
    glenn: 'glen',
    bernie: 'burnie',
    berny: 'burnie',
    bowy: 'bowie',
    booie: 'bowie',
    lanem: 'lanham',
    lanhamm: 'lanham',
    croftonn: 'crofton',
    millersvile: 'millersville',
    pasadenaa: 'pasadena',
    gambrillss: 'gambrills',
    arundele: 'arundel',
    marylin: 'maryland'
  },

  // ===== MACHINE DETECTION =====
  machineTypes: [
    {
      name: 'Riding mower',
      keywords: ['riding', 'tractor', 'riding mower', 'lawn tractor', 'ride mower', 'rider']
    },
    {
      name: 'Lawnmower',
      keywords: ['lawn mower', 'mower', 'push mower', 'lawnmower']
    },
    {
      name: 'Generator',
      keywords: ['generator', 'gen']
    },
    {
      name: 'Pressure washer',
      keywords: ['pressure washer', 'power washer']
    },
    {
      name: 'Snowblower',
      keywords: ['snow blower', 'snowblower', 'snow thrower']
    }
  ],

  // ===== ISSUE DETECTION =====
  symptomKeywords: [
    'start', 'won t', 'wont', 'smoke', 'stall', 'surge',
    'leak', 'blade', 'belt', 'carb', 'starter',
    'tune', 'oil', 'pull', 'dead', 'flat', 'tire',
    'battery', 'cut', 'clog', 'overheat', 'backfire', 'spark',
    'shut off', 'click', 'noise', 'vibrat', 'fuel', 'choke',
    'flood', 'not running', 'dies', 'sputt', 'rpm', 'throttle',
    'string', 'deck', 'brake'
  ],

  vagueIssuePhrases: [
    'work done',
    'worked on',
    'looked at',
    'checked out',
    'not working',
    'doesn t work',
    'doesnt work',
    'needs fixed',
    'needs repair',
    'needs work',
    'broken',
    'fix it',
    'repair it'
  ],

  machineOnlyWords: [
    'lawnmower', 'lawn mower', 'mower', 'riding mower', 'lawn tractor',
    'tractor', 'generator', 'pressure washer', 'power washer',
    'snowblower', 'snow blower'
  ]
};
