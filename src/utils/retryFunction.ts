const retryFunction = async <T>(func: () => Promise<T>, maxAttempt: number): Promise<T> => {
  let attemptCount = 0;
  while (attemptCount < maxAttempt) {
    attemptCount += 1;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await func();
      return result;
    } catch (error) {
      // do nothing, just retry
    }
  }
  throw new Error('Maximum number of attempts reached');
};

export default retryFunction;
