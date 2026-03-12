export const getFormattedTime = (inputDate: Date): string => {
  if (inputDate) {
    return inputDate.toLocaleTimeString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour12: false,
      hour: 'numeric',
      minute: '2-digit',
    });
  }
  return new Date().toLocaleTimeString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour12: false,
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'longGeneric',
  });
};

export const formatDateTimeForMassScanner = (date: Date): string => {
  // Format date and time parts separately
  const year = date.getFullYear().toString().slice(-2); // Get the last two digits of the year
  const month = `0${date.getMonth() + 1}`.slice(-2); // Month is zero-indexed
  const day = `0${date.getDate()}`.slice(-2);
  const hour = `0${date.getHours()}`.slice(-2);
  const minute = `0${date.getMinutes()}`.slice(-2);

  // Combine formatted date and time with a slash
  const formattedDateTime = `${day}/${month}/${year} ${hour}:${minute}`;

  return formattedDateTime;
};
