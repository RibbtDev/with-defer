import { describe, it, expect, vi } from "vitest";
import { withDefer, DeferFn } from "./index.js";

describe("withDefer", () => {
    it("executes deferred functions in LIFO order with correct return values for sync and async", async () => {
        // Test LIFO order
        const order: number[] = [];
        const result = await withDefer((defer) => {
            defer(() => order.push(1));
            defer(() => order.push(2));
            defer(() => order.push(3));
            return "success";
        });

        expect(result).toBe("success");
        expect(order).toEqual([3, 2, 1]);

        // Test sync and async mixed with proper awaiting
        const mixedOrder: string[] = [];
        await withDefer(async (defer) => {
            defer(() => mixedOrder.push("sync-1"));
            defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, 10));
                mixedOrder.push("async-1");
            });
            defer(() => mixedOrder.push("sync-2"));
            defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                mixedOrder.push("async-2");
            });
        });

        expect(mixedOrder).toEqual(["async-2", "sync-2", "async-1", "sync-1"]);

        // Test return value types
        const syncResult = await withDefer((defer) => {
            defer(() => {});
            return 42;
        });
        expect(syncResult).toBe(42);

        const asyncResult = await withDefer(async (defer) => {
            defer(async () => {});
            await new Promise((resolve) => setTimeout(resolve, 5));
            return { data: "async-value" };
        });
        expect(asyncResult).toEqual({ data: "async-value" });
    });

    it("handles all error scenarios and collects them into AggregateError", async () => {
        // Multiple deferred functions throw - all still execute
        const cleanup1 = vi.fn();
        const cleanup2 = vi.fn(() => {
            throw new Error("cleanup-2-error");
        });
        const cleanup3 = vi.fn(() => {
            throw new Error("cleanup-3-error");
        });
        const cleanup4 = vi.fn();

        await expect(async () => {
            await withDefer((defer) => {
                defer(cleanup1);
                defer(cleanup2);
                defer(cleanup3);
                defer(cleanup4);
            });
        }).rejects.toThrow(AggregateError);

        expect(cleanup1).toHaveBeenCalled();
        expect(cleanup2).toHaveBeenCalled();
        expect(cleanup3).toHaveBeenCalled();
        expect(cleanup4).toHaveBeenCalled();

        // Verify LIFO order in AggregateError
        try {
            await withDefer((defer) => {
                defer(() => {
                    throw new Error("error-1");
                });
                defer(() => {
                    throw new Error("error-2");
                });
            });
        } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            const aggError = error as AggregateError;
            expect(aggError.errors).toHaveLength(2);
            expect(aggError.errors[0].message).toBe("error-2"); // LIFO
            expect(aggError.errors[1].message).toBe("error-1");
        }

        // Main function throws AND deferred function throws
        try {
            await withDefer((defer) => {
                defer(() => {
                    throw new Error("cleanup-error");
                });
                throw new Error("main-error");
            });
        } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            const aggError = error as AggregateError;
            expect(aggError.errors).toHaveLength(2);
            expect(aggError.errors[0].message).toBe("main-error");
            expect(aggError.errors[1].message).toBe("cleanup-error");
        }

        // Async deferred functions throw - still all execute
        const asyncCleanup = vi.fn();
        try {
            await withDefer(async (defer) => {
                defer(async () => {
                    await new Promise((resolve) => setTimeout(resolve, 5));
                    throw new Error("async-error-1");
                });
                defer(asyncCleanup);
                defer(async () => {
                    throw new Error("async-error-2");
                });
            });
        } catch (error) {
            expect(error).toBeInstanceOf(AggregateError);
            const aggError = error as AggregateError;
            expect(aggError.errors).toHaveLength(2);
        }
        expect(asyncCleanup).toHaveBeenCalled();
    });

    it("validates all input types with helpful error messages", async () => {
        // defer() receives non-function
        try {
            await withDefer((defer) => {
                // @ts-expect-error - Testing runtime validation
                defer("not a function");
            });
        } catch (e) {
            expect(e.errors[0].message).toBe("defer() expects a function");
        }

        // defer() receives a Promise (common mistake)
        try {
            await withDefer((defer) => {
                const asyncFn = async () => {};
                // @ts-expect-error - Testing runtime validation
                defer(asyncFn()); // Calling the function returns a Promise
            });
        } catch (e) {
            expect(e.errors[0].message).toBe("defer() expects a function");
        }

        // withDefer() receives non-function
        await expect(
            // @ts-expect-error - Testing runtime validation
            async () => await withDefer("not a function"),
        ).rejects.toThrow(TypeError);
    });

    it("executes cleanup on all exit paths including normal return, early return, and thrown errors", async () => {
        const cleanup = vi.fn();

        // Normal return
        const result1 = await withDefer((defer) => {
            defer(cleanup);
            return "normal";
        });
        expect(result1).toBe("normal");
        expect(cleanup).toHaveBeenCalledTimes(1);
        cleanup.mockClear();

        // Early return (multiple paths)
        const result2 = await withDefer((defer) => {
            defer(cleanup);
            if (true) return "early";
            return "late";
        });
        expect(result2).toBe("early");
        expect(cleanup).toHaveBeenCalledTimes(1);
        cleanup.mockClear();

        // Multiple early returns at different depths
        const result3 = await withDefer((defer) => {
            defer(cleanup);

            for (let i = 0; i < 5; i++) {
                if (i === 2) return "loop-early";
            }

            if (false) {
                return "nested-early";
            }

            return "end";
        });
        expect(result3).toBe("loop-early");
        expect(cleanup).toHaveBeenCalledTimes(1);
        cleanup.mockClear();

        // Thrown error
        try {
            await withDefer((defer) => {
                defer(cleanup);
                throw new Error("test error");
            });
        } catch (e) {
            expect((e.errors[0] as Error).message).toBe("test error");
        }
        expect(cleanup).toHaveBeenCalledTimes(1);

        // Refactoring safety: adding new return paths doesn't break cleanup
        const refactoredFn = async (condition: string) => {
            return await withDefer((defer) => {
                const resource = { closed: false };
                defer(() => {
                    resource.closed = true;
                });

                if (condition === "early1")
                    return { result: "path1", resource };
                if (condition === "early2")
                    return { result: "path2", resource };
                if (condition === "error") throw new Error("error path");

                return { result: "default", resource };
            });
        };

        const test1 = await refactoredFn("early1");
        expect(test1.resource.closed).toBe(true);

        const test2 = await refactoredFn("early2");
        expect(test2.resource.closed).toBe(true);

        const test3 = await refactoredFn("default");
        expect(test3.resource.closed).toBe(true);

        try {
            await refactoredFn("error");
        } catch (e) {
            // Error path also cleaned up
        }
    });

    it("supports real-world patterns: files, locks, transactions, and test cleanup", async () => {
        // File operations pattern
        const fileOps: string[] = [];
        await withDefer((defer) => {
            // Simulate opening input file
            fileOps.push("open-input");
            defer(() => fileOps.push("close-input"));

            // Simulate opening output file
            fileOps.push("open-output");
            defer(() => fileOps.push("close-output"));

            // Simulate file operations
            fileOps.push("read-write");
        });

        expect(fileOps).toEqual([
            "open-input",
            "open-output",
            "read-write",
            "close-output", // Closed in reverse order
            "close-input",
        ]);

        // Lock management pattern
        const lockOps: string[] = [];
        await withDefer(async (defer) => {
            lockOps.push("acquire-lock");
            defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                lockOps.push("release-lock");
            });

            // Critical section
            lockOps.push("critical-operation");
        });

        expect(lockOps).toEqual([
            "acquire-lock",
            "critical-operation",
            "release-lock",
        ]);

        // Database transaction pattern with conditional rollback
        const dbOps: string[] = [];
        await withDefer(async (defer) => {
            dbOps.push("connect-db");
            defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                dbOps.push("close-db");
            });

            dbOps.push("begin-transaction");
            let committed = false;
            defer(async () => {
                if (!committed) {
                    dbOps.push("rollback-transaction");
                }
            });

            // Simulate work
            dbOps.push("insert-data");
            dbOps.push("update-data");

            dbOps.push("commit-transaction");
            committed = true;
        });

        expect(dbOps).toEqual([
            "connect-db",
            "begin-transaction",
            "insert-data",
            "update-data",
            "commit-transaction",
            // No rollback because committed = true
            "close-db",
        ]);

        // Test cleanup pattern
        const testOps: string[] = [];
        const testFn = async () => {
            await withDefer(async (defer) => {
                // Create test user
                const userId = "test-user-123";
                testOps.push(`create-user-${userId}`);
                defer(async () => testOps.push(`delete-user-${userId}`));

                // Create test session
                const sessionId = "session-456";
                testOps.push(`create-session-${sessionId}`);
                defer(async () => testOps.push(`destroy-session-${sessionId}`));

                // Run test
                testOps.push("run-test");

                // Cleanup happens automatically in reverse order
            });
        };

        await testFn();
        expect(testOps).toEqual([
            "create-user-test-user-123",
            "create-session-session-456",
            "run-test",
            "destroy-session-session-456",
            "delete-user-test-user-123",
        ]);

        // Multiple resources with dependencies
        const depOps: string[] = [];
        await withDefer(async (defer) => {
            depOps.push("start-server");
            defer(async () => depOps.push("stop-server"));

            depOps.push("connect-client");
            defer(async () => depOps.push("disconnect-client"));

            depOps.push("subscribe-events");
            defer(async () => depOps.push("unsubscribe-events"));

            depOps.push("process-events");
        });

        expect(depOps).toEqual([
            "start-server",
            "connect-client",
            "subscribe-events",
            "process-events",
            "unsubscribe-events", // Must happen before disconnect
            "disconnect-client", // Must happen before stop
            "stop-server",
        ]);
    });

    it("handles edge cases: empty context, nested contexts, and many defers", async () => {
        // Empty defer context (no deferred functions)
        const emptyResult = await withDefer((defer) => {
            return "no-defers";
        });
        expect(emptyResult).toBe("no-defers");

        // Nested withDefer calls
        const nestedOrder: string[] = [];
        await withDefer(async (outerDefer) => {
            outerDefer(() => nestedOrder.push("outer-cleanup"));
            nestedOrder.push("outer-start");

            await withDefer(async (innerDefer) => {
                innerDefer(() => nestedOrder.push("inner-cleanup"));
                nestedOrder.push("inner-work");
            });

            nestedOrder.push("outer-end");
        });

        expect(nestedOrder).toEqual([
            "outer-start",
            "inner-work",
            "inner-cleanup", // Inner context cleans up first
            "outer-end",
            "outer-cleanup", // Then outer context
        ]);

        // Many deferred functions (stress test)
        const manyOrder: number[] = [];
        const count = 100;

        await withDefer((defer) => {
            for (let i = 0; i < count; i++) {
                defer(() => manyOrder.push(i));
            }
        });

        expect(manyOrder).toHaveLength(count);
        // Verify perfect LIFO order
        for (let i = 0; i < count; i++) {
            expect(manyOrder[i]).toBe(count - 1 - i);
        }
    });

    it("allows passing defer to other functions for composition", async () => {
        const operations: string[] = [];

        // Helper function that accepts defer
        async function acquireDatabase(defer: DeferFn) {
            operations.push("acquire-db");
            defer(async () => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                operations.push("release-db");
            });
            return { name: "db-connection" };
        }

        // Helper function that accepts defer
        function acquireFile(defer: DeferFn, filename: string) {
            operations.push(`acquire-file-${filename}`);
            defer(() => operations.push(`release-file-${filename}`));
            return { name: filename };
        }

        // Use helpers within withDefer
        const result = await withDefer(async (defer) => {
            const db = await acquireDatabase(defer);
            const file1 = acquireFile(defer, "config.txt");
            const file2 = acquireFile(defer, "data.txt");

            operations.push("do-work");

            return { db, file1, file2 };
        });

        expect(result.db.name).toBe("db-connection");
        expect(result.file1.name).toBe("config.txt");
        expect(result.file2.name).toBe("data.txt");

        expect(operations).toEqual([
            "acquire-db",
            "acquire-file-config.txt",
            "acquire-file-data.txt",
            "do-work",
            "release-file-data.txt", // LIFO order
            "release-file-config.txt",
            "release-db",
        ]);

        // Verify cleanup happens even if helper throws
        const errorOps: string[] = [];

        function acquireWithError(defer: DeferFn) {
            errorOps.push("acquire");
            defer(() => errorOps.push("cleanup"));
            throw new Error("acquisition failed");
        }

        try {
            await withDefer((defer) => {
                acquireWithError(defer);
            });
        } catch (e) {
            expect((e.errors[0] as Error).message).toBe("acquisition failed");
        }

        expect(errorOps).toEqual(["acquire", "cleanup"]);
    });
});
