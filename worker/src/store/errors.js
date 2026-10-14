/* Errors an adapter may throw on purpose. Anything else is treated as the database being unavailable. */
export class StoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'StoreError';
    this.code = code;   // 'email_taken', 'username_taken', 'phone_taken', 'trip_exists', 'friendship_exists'
  }
}
