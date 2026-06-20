/** Compile-time exhaustiveness guard. In the `default` arm of a switch over a
 *  union, `assertNever(x)` fails to compile if a new member was added without a
 *  case (its argument is no longer `never`). Throws if somehow reached at
 *  runtime — which means the type contract was violated upstream. */
export function assertNever(value: never): never {
  throw new Error(`Unhandled union member: ${JSON.stringify(value)}`);
}
