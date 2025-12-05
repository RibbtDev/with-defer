# defer.js

Go-style defer functionality for JavaScript and TypeScript. Declare cleanup functions right next to resource acquisition, and they'll execute automatically in the correct order when your function exits.

## Quick Start

```bash
npm install defer.js
```

```javascript
import { withDefer } from 'defer.js';

await withDefer(async (defer) => {
  const file = openFile('data.txt');
  defer(() => file.close());  // Cleanup declared right here
  
  const db = await connectDatabase();
  defer(async () => await db.close());
  
  return await processData(file.read());
  // Both resources cleaned up automatically in reverse order
});
```

## Why defer?

Managing resource cleanup becomes error-prone when you have multiple exit paths:

```javascript
function processData() {
  const file = openFile('data.txt');
  const conn = connectDB();
  
  try {
    const data = file.read();
    if (!isValid(data)) return null;
    
    const result = transform(data);
    if (result.error) throw result.error;
    
    return result;
  } finally {
    conn.close();  // Cleanup is far from acquisition
    file.close();  // Hard to see what resources are managed
  }
}
```

With defer, cleanup is paired with acquisition:

```javascript
await withDefer((defer) => {
  const file = openFile('data.txt');
  defer(() => file.close());  // Obvious pairing
  
  const conn = connectDB();
  defer(() => conn.close());  // Clear ownership
  
  const data = file.read();
  if (!isValid(data)) return null;
  
  const result = transform(data);
  if (result.error) throw result.error;
  
  return result;
  // Cleanup: conn.close(), then file.close() - automatic and correct
});
```

## Key Benefits

**Cleanup stays with acquisition.** When you acquire a resource, you immediately declare how to clean it up. No scrolling to a distant finally block to understand resource management.

**Guaranteed execution.** Cleanup runs on every exit path - normal return, early return, or thrown error. You declare it once and it always happens.

**Correct order automatically.** Resources clean up in reverse order (LIFO). If resource B depends on resource A, and you acquire A then B, defer ensures B cleans up before A. This happens automatically without manual ordering.

**Refactoring safety.** Add early returns or change control flow without updating cleanup code. The cleanup you declared keeps working.

**Works with sync and async.** One API handles synchronous cleanup, asynchronous cleanup, or mixed - no need to choose different functions.

## Common Patterns

### Database transactions

```javascript
await withDefer(async (defer) => {
  const db = await connectDB();
  defer(async () => await db.close());
  
  const tx = await db.beginTransaction();
  let committed = false;
  defer(async () => {
    if (!committed) await tx.rollback();
  });
  
  await tx.execute('INSERT INTO users VALUES (...)');
  await tx.execute('UPDATE accounts SET balance = ...');
  
  await tx.commit();
  committed = true;
});
```

### File operations

```javascript
await withDefer((defer) => {
  const input = fs.openSync('input.txt', 'r');
  defer(() => fs.closeSync(input));
  
  const output = fs.openSync('output.txt', 'w');
  defer(() => fs.closeSync(output));
  
  const buffer = Buffer.alloc(1024);
  const bytesRead = fs.readSync(input, buffer);
  fs.writeSync(output, buffer, 0, bytesRead);
});
```

### Lock management

```javascript
await withDefer(async (defer) => {
  await mutex.lock();
  defer(async () => await mutex.unlock());
  
  // Critical section protected by lock
  await performCriticalOperation();
  // Lock automatically released even if operation throws
});
```

### Test cleanup

```javascript
test('user workflow', async () => {
  await withDefer(async (defer) => {
    const user = await createTestUser();
    defer(async () => await deleteUser(user.id));
    
    const session = await createSession(user);
    defer(async () => await destroySession(session.id));
    
    // Test your code - cleanup happens automatically
    expect(session.userId).toBe(user.id);
  });
});
```

### Multiple resources with dependencies

```javascript
await withDefer(async (defer) => {
  const server = await startServer();
  defer(async () => await server.stop());
  
  const client = await connectToServer(server);
  defer(async () => await client.disconnect());
  
  const subscription = await client.subscribe('events');
  defer(async () => await subscription.unsubscribe());
  
  await processEvents(subscription);
  // Cleanup order: unsubscribe → disconnect → stop server
});
```

## API Reference

### withDefer(fn)

Executes `fn` with a defer context. Deferred functions execute in LIFO order when `fn` exits.

```typescript
function withDefer<T>(
  fn: (defer: (callback: () => void | Promise<void>) => void) => T | Promise<T>
): Promise<T>
```

**Parameters:**
- `fn` - Function receiving a `defer` callback for registering cleanup functions

**Returns:** Promise resolving to the return value of `fn`

**Behavior:**
- Deferred functions execute in reverse order (last deferred runs first)
- All deferred functions execute even if the main function throws
- All deferred functions execute even if some deferred functions throw
- If errors occur, they're collected into an `AggregateError`

**Example:**

```javascript
await withDefer(async (defer) => {
  defer(() => console.log('Third'));
  defer(() => console.log('Second'));
  defer(() => console.log('First'));
  console.log('Main');
});
// Output: Main, First, Second, Third
```

### Error Handling

If the main function or any deferred function throws, all deferred functions still execute. Errors are collected:

```javascript
try {
  await withDefer((defer) => {
    defer(() => { throw new Error('Cleanup 1 failed'); });
    defer(() => console.log('This still runs'));
    defer(() => { throw new Error('Cleanup 2 failed'); });
    
    throw new Error('Main failed');
  });
} catch (error) {
  console.log(error instanceof AggregateError); // true
  console.log(error.errors.length); // 3
  // Errors: [Main failed, Cleanup 2 failed, Cleanup 1 failed]
}
```

### Runtime Validation

The library validates inputs and provides helpful error messages:

```javascript
// ❌ Passing a Promise instead of a function
defer(asyncFunction());
// TypeError: defer() expects a function, not a Promise.
// Use defer(() => yourAsyncFunction()) instead of defer(yourAsyncFunction())

// ❌ Passing a non-function
defer("cleanup");
// TypeError: defer() expects a function

// ✅ Correct usage
defer(() => asyncFunction());
defer(async () => await asyncFunction());
```

## TypeScript Support

Full TypeScript support with type inference:

```typescript
import { withDefer, DeferFn, DeferCallback } from 'defer.js';

// Return type automatically inferred as Promise<string>
const result = await withDefer(async (defer) => {
  defer(() => cleanup());
  return "result";
});

// Use exported types for passing defer to functions
async function acquireResource(defer: DeferFn) {
  const resource = await acquire();
  defer(async () => await release(resource));
  return resource;
}

await withDefer(async (defer) => {
  const res = await acquireResource(defer);
  return await process(res);
});
```

**Exported Types:**
- `DeferCallback` - Type for cleanup functions: `() => any` (return values are ignored)
- `DeferFn` - Type for the defer function itself: `(callback: DeferCallback) => void`

## Comparison with Go

This library implements Go's `defer` pattern for JavaScript:

**Go's defer behavior:**
- ✅ LIFO execution order (last deferred runs first)
- ✅ Executes on all exit paths (return, throw)
- ✅ Return values from deferred functions are ignored
- ✅ All deferred functions execute even if some fail

**JavaScript difference:**
- Code must be wrapped in `withDefer()` instead of using a language keyword

## License

MIT
