/** Test runtime shim only. Production resolves the real platform entrypoint. */
export class WorkerEntrypoint<Env> {
 constructor(protected ctx:ExecutionContext,protected env:Env) {}
}
