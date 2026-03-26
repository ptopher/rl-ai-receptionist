// ONLY showing NEW + UPDATED FUNCTIONS (everything else stays EXACTLY the same)

// ===== FIND MULTIPLE AVAILABLE SLOTS =====
async function findMultipleAvailableSlots(zip, startOffsetDays = 1, maxOptions = 3) {
  const matchingCounties = getCountyForZip(zip);
  if (matchingCounties.length === 0) return [];

  const existingJobs = loadJobs();
  const now = getEasternNow();

  const results = [];

  for (let offset = startOffsetDays; offset <= 30; offset++) {
    if (results.length >= maxOptions) break;

    const future = new Date(now);
    future.setDate(now.getDate() + offset);

    const serviceDate = formatEasternDateKey(future);
    const dayName = getDayNameInEastern(future);

    if (dayName === 'Sunday') continue;

    const dayJobs = getAppointmentJobsForDate(existingJobs, serviceDate);

    // MON–THU
    if (['Monday','Tuesday','Wednesday','Thursday'].includes(dayName)) {
      const targetCounty = routingConfig.mondayThroughThursdayPlan[dayName];
      if (!matchingCounties.includes(targetCounty)) continue;

      if (dayJobs.length < routingConfig.mondayThursdayMax) {
        results.push({
          serviceDate,
          serviceDay: dayName,
          serviceCounty: targetCounty,
          serviceWindow: routingConfig.mondayThursdayWindow
        });
      }
    }

    // FRI/SAT
    if (dayName === 'Friday' || dayName === 'Saturday') {
      const allowed =
        dayName === 'Friday'
          ? routingConfig.fridayAllowedCounties
          : routingConfig.saturdayAllowedCounties;

      const matchedAllowed = matchingCounties.find((c) =>
        allowed.includes(c)
      );

      if (!matchedAllowed) continue;

      if (
        dayJobs.length <
        routingConfig.fridaySaturdayMorningMax +
          routingConfig.fridaySaturdayAfternoonMax
      ) {
        results.push({
          serviceDate,
          serviceDay: dayName,
          serviceCounty: matchedAllowed,
          serviceWindow:
            dayJobs.length < routingConfig.fridaySaturdayMorningMax
              ? routingConfig.fridaySaturdayMorningWindow
              : routingConfig.fridaySaturdayAfternoonWindow
        });
      }
    }
  }

  return results;
}

// ===== DETECT FUTURE REQUEST (LIKE 2 WEEKS) =====
function detectFutureOffset(text) {
  const t = cleanText(text);

  if (t.includes('2 week') || t.includes('two week')) return 14;
  if (t.includes('next week')) return 7;
  if (t.includes('week')) return 7;
  if (t.includes('later')) return 5;

  return 1;
}

// ===== UPDATED ZIP STEP =====
app.post('/getZipForAppointment', async (req, res) => {
  const machine = req.query.machine;
  const issue = req.query.issue;
  const zip = (req.body.Digits || '').slice(0, 5);

  const slots = await findMultipleAvailableSlots(zip);

  res.type('text/xml');

  if (!slots.length) {
    res.send(`<Response><Say>Sorry, we have no availability.</Say></Response>`);
    return;
  }

  let speech = `Here are the next available appointments. `;

  slots.forEach((s, i) => {
    const readable = getReadableDate(s.serviceDate);
    speech += `Option ${i + 1}: ${readable}, between ${s.serviceWindow}. `;
  });

  res.send(`
<Response>
  <Say>${speech}</Say>
  <Gather input="speech" action="/selectSlot?zip=${zip}&machine=${encodeURIComponent(machine)}&issue=${encodeURIComponent(issue)}" method="POST">
    <Say>Please say option 1, 2, or 3. You can also say a future time like next week.</Say>
  </Gather>
</Response>
`);
});

// ===== SLOT SELECTION =====
app.post('/selectSlot', async (req, res) => {
  const zip = req.query.zip;
  const machine = req.query.machine;
  const issue = req.query.issue;
  const answer = req.body.SpeechResult || '';

  let offset = detectFutureOffset(answer);
  let slots = await findMultipleAvailableSlots(zip, offset);

  let index = 0;

  if (answer.includes('2')) index = 1;
  if (answer.includes('3')) index = 2;

  const selected = slots[index];

  if (!selected) {
    res.type('text/xml');
    res.send(`<Response><Say>Sorry, I didn’t understand. Goodbye.</Say></Response>`);
    return;
  }

  res.type('text/xml');
  res.send(`
<Response>
  <Say>Great choice.</Say>
  <Gather input="speech" action="/getNameForAppointment?machine=${machine}&issue=${issue}&zip=${zip}&serviceDate=${selected.serviceDate}&serviceDay=${selected.serviceDay}&serviceCounty=${selected.serviceCounty}&serviceWindow=${selected.serviceWindow}" method="POST">
    <Say>Can I get your first and last name?</Say>
  </Gather>
</Response>
`);
});
