import type { ProjectContent } from "./projectContent.ts";
import { parseLogicSyntax, type Stmt, type Ref, type TestExpr } from "../logic/syntax.ts";
import { assembleLogic } from "../logic/assembler.ts";
import { decodeLogicInsns } from "../logic/disassembler.ts";
import { parseLogicResource } from "../logic/resource.ts";
import { openContainer } from "../container/container.ts";
import { RELEASED_LOGIC0 } from "./releasedTemplateContract.ts";

export { isRecognizedOriginal } from "./projectConventions.ts";

type Syntax = ReturnType<typeof parseLogicSyntax>;
function operand(ref: Ref, syntax: Syntax): unknown {
  if (ref.kind === "str") return ref.text;
  if (ref.kind === "m") return syntax.explicitMessages.get(ref.index);
  return ref.kind === "num" ? ref.value : ref.index;
}
function condition(test: TestExpr, syntax: Syntax): unknown {
  switch (test.type) {
    case "cond": return [test.name, ...test.args.map((ref) => operand(ref, syntax))];
    case "not": case "group": return [test.type, condition(test.inner, syntax)];
    case "and": case "or": return [test.type, ...test.parts.map((part) => condition(part,syntax))];
  }
}
function statement(stmt: Stmt, syntax: Syntax): unknown {
  switch (stmt.type) {
    case "if": return ["if", condition(stmt.test,syntax), stmt.then.map((s)=>statement(s,syntax)), stmt.else_?.map((s)=>statement(s,syntax)) ?? null];
    case "action": return [stmt.name, ...stmt.args.map((ref)=>operand(ref,syntax))];
    case "return": return ["return"];
    default: return [stmt.type, stmt.type === "label" ? stmt.name : stmt.label];
  }
}
function same(stmt: Stmt, syntax: Syntax, expected: Stmt, reference: Syntax): boolean {
  return JSON.stringify(statement(stmt,syntax)) === JSON.stringify(statement(expected,reference));
}
function walk(program: readonly Stmt[]): Stmt[] {
  return program.flatMap((stmt)=>[stmt, ...(stmt.type === "if" ? [...walk(stmt.then), ...walk(stmt.else_ ?? [])] : [])]);
}
// The resolved contracts shipped in 1.0–1.2.4. Raw v/f operands and mN
// messages compare identically to their later named/inline spellings.
const reference = parseLogicSyntax(RELEASED_LOGIC0);
const releasedBoot = reference.program[0]!;
const releasedFeedback = reference.program.at(-1)!;

function safeSyntax(source: string): Syntax | null {
  try {
    const syntax = parseLogicSyntax(source);
    // Strict compile validates the instruction vocabulary and operands too.
    // said strings require a dictionary, so use synthetic ids solely for validation.
    const words = new Map<string,number>();
    for (const stmt of walk(syntax.program)) if (stmt.type === "if") {
      const visit = (test: TestExpr): void => {
        if (test.type === "cond" && test.name === "said") { for (const arg of test.args) if (arg.kind === "str") words.set(arg.text, 1); }
        else if (test.type === "not" || test.type === "group") visit(test.inner);
        else if (test.type === "and" || test.type === "or") test.parts.forEach(visit);
      };
      visit(stmt.test);
    }
    assembleLogic(source,{dictionary:words});
    return syntax;
  } catch { return null; }
}
/** Prove the boot flag is written only by the released block, across the whole game. */
function uniqueFlagWrite(syntax: Syntax, flag: number, files?: Readonly<Record<string,Uint8Array>>): boolean {
  const statements = walk(syntax.program);
  if (statements.some((s)=>s.type === "goto" || s.type === "label")) return false;
  if (statements.some((s)=>s.type === "action" && ["set.v","reset.v","toggle.v"].includes(s.name))) return false;
  const writes = statements.filter((s)=>s.type === "action" && ["set","reset","toggle"].includes(s.name) && operand(s.args[0]!,syntax) === flag);
  if (writes.length !== 1) return false;
  if (files) {
    try {
      const container = openContainer(new Map(Object.entries(files)));
      for (let n=1;n<256;n++) {
        const payload = container.getResource("logic",n);
        if (!payload) continue;
        const insns = decodeLogicInsns(payload);
        if (insns.some((i)=>i.kind === "data" || (i.kind === "action" && (["set.v","reset.v","toggle.v"].includes(i.name!) || (["set","reset","toggle"].includes(i.name!) && i.args?.[0] === flag))))) return false;
      }
    } catch { return false; }
  }
  return true;
}
function bootMatch(syntax: Syntax, files?: Readonly<Record<string,Uint8Array>>): Stmt | undefined {
  const matches = syntax.program.filter((s)=>same(s,syntax,releasedBoot,reference));
  return matches.length === 1 && uniqueFlagWrite(syntax,200,files) ? matches[0] : undefined;
}
interface Edit {start:number; end:number; text:string}
function patched(source: string, edits: Edit[]): string {
  return edits.sort((a,b)=>b.start-a.start).reduce((text,edit)=>text.slice(0,edit.start)+edit.text+text.slice(edit.end),source);
}
function feedbackEdits(stmt: Stmt): Edit[] {
  return walk([stmt]).flatMap((s)=>s.type === "action" && s.name === "word.to.string" ? [{start:s.args[1]!.tok!.start,end:s.args[1]!.tok!.end,text:String((s.args[1] as {value:number}).value-1)}] : []);
}
/** Exact released blocks only; all edits share the caller's single transaction. */
export function migrateScriptSize(documents: Readonly<Record<string,ProjectContent>>, files?: Readonly<Record<string,Uint8Array>>): Record<string,ProjectContent> | null {
  const source = documents["logic:0"];
  if (typeof source !== "string") return null;
  const syntax = safeSyntax(source);
  if (!syntax) return null;
  const edits: Edit[] = [];
  const match = bootMatch(syntax,files);
  if (match?.type === "if" && !walk(syntax.program).some((s)=>s.type === "action" && s.name === "script.size")) {
    const at = match.then[0]!.end;
    edits.push({start:at,end:at,text:"\n  script.size(200);"});
  }
  const fallback = syntax.program.filter((s)=>same(s,syntax,releasedFeedback,reference));
  if (fallback.length === 1) edits.push(...feedbackEdits(fallback[0]!));
  return edits.length ? {...documents,"logic:0":patched(source,edits)} : null;
}

/** GAME.JSON-only legacy exports qualify only with the exact decoded boot contract. */
export function hasReleasedBoot(files: Readonly<Record<string,Uint8Array>>): boolean {
  try {
    const payload = openContainer(new Map(Object.entries(files))).getResource("logic",0);
    if (!payload) return false;
    const insns = decodeLogicInsns(payload);
    const expectedPayload = assembleLogic(RELEASED_LOGIC0, {dictionary:new Map()}).payload;
    const expected = decodeLogicInsns(expectedPayload);
    const guard = expected[0]!;
    const block = expected.filter((i)=>i.at < guard.target);
    const messages = parseLogicResource(payload).messages;
    const expectedMessages = parseLogicResource(expectedPayload).messages;
    const normalize = (i: typeof guard, start:number, texts: typeof messages) => [i.kind,i.text,i.name,i.args?.map((arg,j)=> ["set.menu","set.menu.item"].includes(i.name!) && j === 0 ? texts[arg-1] : arg),i.kind === "if" || i.kind === "goto" ? i.target-start : undefined];
    return insns.some((i,index)=>i.kind === "if" && JSON.stringify(insns.slice(index,index+block.length).map((s)=>normalize(s,i.at,messages))) === JSON.stringify(block.map((s)=>normalize(s,0,expectedMessages))));
  } catch { return false; }
}

function isCorrectFeedback(stmt: Stmt, syntax: Syntax): boolean {
  const corrected = parseLogicSyntax(patched(RELEASED_LOGIC0,feedbackEdits(releasedFeedback)));
  return same(stmt,syntax,corrected.program.at(-1)!,corrected);
}
/** Fail closed on indirect flag access, unknown instructions and jumps. All
 * current LOGIC resources are checked; this proof is only for a revision-bound Add. */
function unusedFlag(syntax: Syntax, files: Readonly<Record<string,Uint8Array>>): number | undefined {
  const used = new Set<number>();
  const statements = walk(syntax.program);
  if (statements.some(s=>s.type === "goto" || s.type === "label" || (s.type === "action" && ["set.v","reset.v","toggle.v","set.scan.start"].includes(s.name)))) return undefined;
  const refs = (test:TestExpr): void => {
    if(test.type === "cond") test.args.forEach(arg=>{if(arg.kind !== "str") used.add(arg.kind === "num" ? arg.value : arg.index);});
    else if(test.type === "not" || test.type === "group") refs(test.inner);
    else test.parts.forEach(refs);
  };
  for(const stmt of statements) {
    if(stmt.type === "action") stmt.args.forEach(arg=>{if(arg.kind !== "str") used.add(arg.kind === "num" ? arg.value : arg.index);});
    if(stmt.type === "if") refs(stmt.test);
  }
  try {
    const c=openContainer(new Map(Object.entries(files)));
    for(let n=0;n<256;n++) {
      const payload=c.getResource("logic",n); if(!payload) continue;
      for(const insn of decodeLogicInsns(payload)) {
        if(insn.kind === "data" || insn.kind === "goto" || ["set.v","reset.v","toggle.v","set.scan.start"].includes(insn.name ?? "")) return undefined;
        insn.args?.forEach(arg=>used.add(arg));
        if(insn.kind === "if") { const tree=parseLogicSyntax(`if (${insn.text}) {}`); const stmt=tree.program[0]!; if(stmt.type === "if") refs(stmt.test); }
      }
    }
  } catch {return undefined;}
  for(let flag=255;flag>=32;flag--) if(!used.has(flag)) return flag;
  return undefined;
}

export interface GameUpdate {kind:"memory" | "words"; title:string; message:string; source?:string; preview?:string}
/** Notice rows are limited to legacy projects; no invented fallback for Blank/remixes. */
export function gameUpdates(documents: Readonly<Record<string,ProjectContent>>, files: Readonly<Record<string,Uint8Array>>, legacy: boolean): GameUpdate[] {
  if (!legacy) return [];
  const source = documents["logic:0"];
  const syntax = typeof source === "string" ? safeSyntax(source) : null;
  const rows: GameUpdate[] = [];
  let declared = false;
  try { const c=openContainer(new Map(Object.entries(files))); for(let n=0;n<256;n++) { const p=c.getResource("logic",n); if(p && decodeLogicInsns(p).some((i)=>i.name === "script.size")) declared=true; } } catch { /* No safe Add from uncertain resources. */ }
  if (!declared) {
    let updated: string | undefined;
    let preview = "script.size(200);";
    if (syntax && typeof source === "string") {
      const match = bootMatch(syntax,files);
      if (match?.type === "if") { const at=match.then[0]!.end; updated=patched(source,[{start:at,end:at,text:"\n  script.size(200);"}]); }
      else { const flag=unusedFlag(syntax,files); const at=syntax.program[0]?.tok.start; if(flag !== undefined && at !== undefined) { preview=`if (!isset(f${flag})) {\n  set(f${flag});\n  script.size(200);\n}`; updated=patched(source,[{start:at,end:at,text:preview+"\n"}]); } }
    }
    rows.push({kind:"memory",title:"Room memory",message:updated ? "Add room memory for larger rooms." : "Larger rooms use extra memory while this game runs here.", ...(updated ? {source:updated,preview}: {})});
  }
  if (syntax && typeof source === "string") {
    const match=syntax.program.find((s)=>same(s,syntax,releasedFeedback,reference));
    if(match) { const updated=patched(source,feedbackEdits(match)); rows.push({kind:"words",title:"Word feedback",message:"Add feedback for unknown words.",source:updated,preview:updated.slice(match.tok.start,match.end)}); }
    else if (!syntax.program.some((s)=>isCorrectFeedback(s,syntax)) && walk(syntax.program).some((s)=>s.type === "if" && s.test.type === "cond" && s.test.name === "equaln" && operand(s.test.args[0]!,syntax) === 9 && s.then.some((a)=>a.type === "action" && a.name === "word.to.string" && operand(a.args[1]!,syntax) === operand(s.test.type === "cond" ? s.test.args[1]! : a.args[1]!,syntax)))) rows.push({kind:"words",title:"Word feedback",message:"In your word feedback, start counting words at 0."});
  }
  return rows;
}
