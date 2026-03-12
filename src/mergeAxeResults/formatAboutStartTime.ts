const formatAboutStartTime = (dateString: string): string => {
  const utcStartTimeDate = new Date(dateString);
  const formattedStartTime = utcStartTimeDate.toLocaleTimeString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour12: false,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'shortGeneric',
  });

  const timezoneAbbreviation = new Intl.DateTimeFormat('en', {
    timeZoneName: 'shortOffset',
  })
    .formatToParts(utcStartTimeDate)
    .find(part => part.type === 'timeZoneName').value;

  // adding a breakline between the time and timezone so it looks neater on report
  const timeColonIndex = formattedStartTime.lastIndexOf(':');
  const timePart = formattedStartTime.slice(0, timeColonIndex + 3);
  const timeZonePart = formattedStartTime.slice(timeColonIndex + 4);
  const htmlFormattedStartTime = `${timePart}<br>${timeZonePart} ${timezoneAbbreviation}`;

  return htmlFormattedStartTime;
};

export default formatAboutStartTime;
