import { type CommandHandler } from "./types.js";
import * as sessionCmds from "./session-commands.js";
import * as modelCmds from "./model-commands.js";
import * as workspaceCmds from "./workspace-commands.js";
import * as taskCmds from "./task-commands.js";
import * as infoCmds from "./info-commands.js";
import * as contextCmds from "./context-commands.js";
import * as loopCmds from "./loop-command.js";
import * as usageCmds from "./usage-commands.js";

export const commandRegistry: Record<string, CommandHandler> = {
  "/session": sessionCmds.sessionCommand,
  "/sessions": sessionCmds.sessionCommand,
  "/resume": sessionCmds.resumeCommand,
  "/continue": sessionCmds.resumeCommand,
  "/new": async (ctx) => sessionCmds.sessionCommand({ ...ctx, args: ["new"] }),
  "/rewind": sessionCmds.rewindCommand,
  "/rename": sessionCmds.renameCommand,
  "/snapshot": sessionCmds.snapshotCommand,

  "/model": modelCmds.modelCommand,
  "/providers": modelCmds.providersCommand,
  "/model-routing": modelCmds.modelRoutingCommand,

  "/select": workspaceCmds.selectCommand,
  "/unselect": workspaceCmds.unselectCommand,
  "/diff": workspaceCmds.diffCommand,
  "/undo": workspaceCmds.undoCommand,
  "/image": workspaceCmds.imageCommand,
  "/mode": workspaceCmds.modeCommand,
  "/trust": workspaceCmds.trustCommand,

  "/review": taskCmds.reviewCommand,
  "/test": taskCmds.testCommand,
  "/fix-tests": taskCmds.fixTestsCommand,
  "/fix-ci": taskCmds.fixCiCommand,
  "/plan": taskCmds.planCommand,
  "/view-plan": taskCmds.viewPlanCommand,
  "/run-plan": taskCmds.runPlanCommand,

  "/log": infoCmds.logCommand,
  "/stats": infoCmds.statsCommand,
  "/runs": infoCmds.runsCommand,
  "/show-run": infoCmds.showRunCommand,
  "/memory": infoCmds.memoryCommand,
  "/remember": infoCmds.rememberCommand,
  "/forget": infoCmds.forgetCommand,
  "/doctor": infoCmds.doctorCommand,
  "/index": infoCmds.indexCommand,
  "/find": infoCmds.findCommand,
  "/explain": infoCmds.explainCommand,
  "/skills": infoCmds.skillsCommand,
  "/telemetry": infoCmds.telemetryCommand,

  "/todo": contextCmds.todoCommand,
  "/mcp": contextCmds.mcpCommand,
  "/compact": contextCmds.compactCommand,
  "/clear": contextCmds.clearCommand,
  "/variant": contextCmds.variantCommand,
  "/theme": contextCmds.variantCommand,

  "/loop": loopCmds.loopCommand,
  "/usage": usageCmds.usageCommand,
  "/context-window": usageCmds.contextWindowCommand,
  "/context": usageCmds.contextWindowCommand,
};
