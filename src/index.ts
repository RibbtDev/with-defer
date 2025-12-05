/**
 * withDefer - Go-style defer functionality for JavaScript/TypeScript
 *
 * Provides defer context that executes cleanup functions in reverse order (LIFO)
 */

/**
 * Callback function that can be either sync or async
 * Return value is ignored (matching Go's defer behavior)
 */
export type DeferCallback = () => any;

/**
 * Function type for the defer function passed to withDefer
 */
export type DeferFn = (callback: DeferCallback) => void;

/**
 * Creates a defer context that handles cleanup
 * @param fn - Function that receives a defer callback
 * @returns Promise resolving to the return value of fn
 *
 * @example
 * await withDefer(async (defer) => {
 *   const db = await connectDatabase();
 *   defer(async () => await db.close());
 *
 *   const tx = await db.beginTransaction();
 *   defer(async () => await tx.rollback());
 *
 *   await tx.commit();
 *   return await db.query('SELECT * FROM users');
 * });
 */
export async function withDefer<T>(
    fn: (defer: DeferFn) => T | Promise<T>,
): Promise<T> {
    if (typeof fn !== "function") {
        throw new TypeError("withDefer() expects a function");
    }

    const deferred: DeferCallback[] = [];

    const defer: DeferFn = (callback: DeferCallback): void => {
        if (typeof callback !== "function") {
            throw new TypeError("defer() expects a function");
        }

        if (callback instanceof Promise) {
            throw new TypeError(
                "defer() expects a function, not a Promise. " +
                    "Use defer(() => yourAsyncFunction()) instead",
            );
        }

        deferred.push(callback);
    };

    const errors: Error[] = [];
    let result = null;

    try {
        result = await fn(defer);
    } catch (error) {
        // Catches BOTH execution errors AND validation errors
        errors.push(error as Error);
    } finally {
        // Always run whatever defers were registered
        while (deferred.length > 0) {
            const callback = deferred.pop()!;
            try {
                await callback();
            } catch (error) {
                errors.push(error as Error);
            }
        }
    }

    if (errors.length > 0) {
        throw new AggregateError(errors, "Errors in defer execution");
    }

    return result!;
}

export default withDefer;
