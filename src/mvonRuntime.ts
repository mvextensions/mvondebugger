/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import { DebugProtocol } from 'vscode-debugprotocol';
import WebSocket = require('ws');
import { MvonBreakpoint } from './mvonRuntime';

export interface MvonBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

/**
 * A MVON# runtime
 */

export class MvonDebugInfo {
	public fileName: string = "";
	public filePath: string = "";
	public lineNumber: number = 0;
	public variables = new Array<DebugProtocol.Variable>()
	public common = new Array<DebugProtocol.Variable>()
	public arguments = new Array<DebugProtocol.Variable>()

}
export class Synchronise {
	public isConnected = false;
	public isProcessing = true;
	public isOnEntry = true;
	public lastLineProcessed = false;
	public isSteping = false;

}
export class MvonRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string;
	public get sourceFile() {
		return this._sourceFile;
	}
	// array of debug info for each subroutine in the stack
	public debugInfos = new Array<MvonDebugInfo>()

	// the contents (= lines) of the one and only file
	//private _sourceLines: string[];

	// This is the next line that will be 'executed'
	private _currentLine = 0;

	private _remoteDebug = false;

	// maps from sourceFile to array of Mvon breakpoints
	private _breakPoints = new Map<string, MvonBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private frames = new Array<any>();

	private server

	private ws

	private synchronise





	constructor() {
		super();

		// create synchronise object
		this.synchronise = new Synchronise();
		let WebSocketServer = WebSocket.Server;
		let server = new WebSocketServer({ port: 13002 })
		this.server = server
		this.sendEvent('output', "Waiting for remote process to connect")
		server.on('connection', ws => {

			this.ws = ws
			this.processMessage()
		})
	}
	public processMessage() {
		this.ws.on('message', message => {
			let parts = message.split(String.fromCharCode(4))

			if (parts[0] === "setStackTrace") {
				let stack = parts[1].split(String.fromCharCode(5))
				if (this.synchronise.isConnected === true) {
					// just update the stack with the current line no
					let details = stack[0].split(String.fromCharCode(7))
					this.debugInfos[0].lineNumber = Number(details[1])
				}
				else {
					this.debugInfos.length = 0
					for (let i = 0; i < stack.length; i++) {
						let details = stack[i].split(String.fromCharCode(7))
						let info = new MvonDebugInfo();
						info.fileName = details[0]
						info.lineNumber = Number(details[1])
						if (i > 0) {
							// editor has a 0 based line number
							info.lineNumber--
						}
						info.filePath = details[2]
						if (this._remoteDebug === true) {
							let parts = info.filePath.split("\\");
							let dir = '';
							if (parts[parts.length - 1].indexOf("/") > -1) {
								dir = parts[parts.length - 1].split("/")[0];
							}
							else {
								dir = parts[parts.length - 1];
							}

							info.filePath = "MvonFS:/" + dir;
						}
						//info.fileName = "MvonFS:/nb.bp/"+info.fileName;
						this._sourceFile = info.filePath + "/" + info.fileName;
						this.debugInfos.push(info)
					}
					this.synchronise.isConnected = true;
				}
				this._currentLine = this.debugInfos[0].lineNumber
			}
			if (parts[0] === "setVariableData") {

				for (let idx = 1; idx < parts.length; idx++) {
					let varDet = parts[idx].split(String.fromCharCode(5))
					this.debugInfos[idx - 1].variables.length = 0
					for (let i = 0; i < varDet.length; i++) {
						let details = varDet[i].split(String.fromCharCode(7))
						this.debugInfos[idx - 1].variables.push({
							name: details[0],
							type: "String",
							value: details[1],
							variablesReference: 0
						})
					}
				}
				this.synchronise.isProcessing = false
				if (this.synchronise.isOnEntry === true) {
					this._currentLine--
					this.sendEvent('stopOnEntry');
					this.synchronise.isOnEntry = false;
					// fix drive letter bug
					let fileName = this._sourceFile;
					if (!this._remoteDebug) {
						fileName = this._sourceFile.substr(0, 2).toUpperCase() + this._sourceFile.substr(2)
					}
					this._sourceFile = fileName
					// send a list of breakpoints to the remote process
					this.verifyBreakpoints(this._sourceFile);
					this.sendBreakPoint();
				}
				else {
					if (parts[0] === "setVariableData") {
						this._currentLine -= 1
						this.sendEvent('stopOnStep');
					}
				}

			}
		})
	}
	public isRemoteConnected(): any {

		return this.synchronise.isConnected;
	}
	public isRemoteProcessing(): any {
		return this.synchronise.isProcessing;
	}
	public hasVariable(frameNo, variableName) {
		let idx = Number(frameNo) - 1
		let found = false
		this.debugInfos[idx].variables.forEach(variable => {
			if (variable.name === variableName) {
				found = true;
			}
		})
		return found;

	}
	public getVariable(frameNo, variableName) {
		let idx = Number(frameNo) - 1
		let value = ""
		this.debugInfos[idx].variables.forEach(variable => {
			if (variable.name === variableName) {
				value = variable.value;
			}
		})
		return value;

	}
	public getVariableFromFrame(frameNo: string): DebugProtocol.Variable[] {
		let parts = frameNo.split("_")
		let idx = Number(parts[1]) - 1
		switch (parts[0]) {
			case "variables":
				return this.debugInfos[idx].variables;
			case "common":
				return this.debugInfos[idx].common;
			case "arguments":
				return this.debugInfos[idx].arguments;
			default:
				return new Array<DebugProtocol.Variable>()


		}

	}


	// process messages recieved from the debug process

	// disconnect current connection
	public async disconnect() {
		if (this.synchronise.isConnected) {
			this.synchronise.isConnected = false
		}
	}

	public async terminate() {
		this.ws.send('close')
		this.server.close();
	}


	/**
	 * Start executing the given program.
	 */
	public start(program: string, stopOnEntry: boolean, remoteDebug: boolean) {
		console.log("Starting")

		this.loadSource(program);
		this._currentLine = -1;
		this._remoteDebug = remoteDebug

		this.verifyBreakpoints(this._sourceFile);

		if (stopOnEntry) {
			// we step once
			this.step(false, 'stopOnEntry');
		} else {
			// we just start to run until we hit a breakpoint or an exception
			this.continue();
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue(reverse = false) {
		this.synchronise.lastLineProcessed = true;
		this.synchronise.isProcessing = true
		this.ws.send("continue");
		await this.sleep(700); // allow cleanup
		// check if any manual breakpoints were set
		let breakFound = false;
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints && !this.synchronise.isProcessing) {
			const bps = breakpoints.filter(bp => bp.line >= this._currentLine - 1);
			if (bps.length > 0) {

				// send 'stopped' event
				this.synchronise.lastLineProcessed = false
				this._currentLine -= 1
				this.sendEvent('stopOnBreakpoint');
				breakFound = true
			}
		}
		if (!breakFound) {
			// no breakpoint found so close the connect and end

			//this.disconnect()
			//this.sendEvent('end')
		}
		//this.sendEvent("stopOnStep")

	}

	public sleep(ms) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}


	/**
	 * Step to the next/previous non empty line.
	 */
	public async step(reverse = false, event = 'stopOnStep') {
		// send step to remote process
		if (this.synchronise.isConnected) {
			this.synchronise.isProcessing = true
			this.synchronise.isSteping = true
			this.ws.send("step")
			while (this.synchronise.isProcessing) {
				await this.sleep(50)
			}

		}
	}

	public async stepin(reverse = false, event = 'stopOnStep') {
		// send stepin to remote process
		if (this.synchronise.isConnected) {
			this.synchronise.isProcessing = true
			this.synchronise.isSteping = true
			this.ws.send("stepin")
		}
	}


	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public stack(startFrame: number, endFrame: number): any {
		// un comment when sync works
		this.frames.length = 0
		let cnt = 0
		this.debugInfos.forEach(element => {
			if (cnt === 0) {
				this.frames.push({
					index: cnt + 1,
					name: element.fileName,
					file: element.filePath + "/" + element.fileName,
					line: this._currentLine
				})
			} else {
				this.frames.push({
					index: cnt + 1,
					name: element.fileName,
					file: element.filePath + "/" + element.fileName,
					line: element.lineNumber
				})
			}
			cnt++



		});
		return {
			frames: this.frames,
			count: this.frames.length
		};
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number): MvonBreakpoint {

		const bp = <MvonBreakpoint>{ verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<MvonBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);
		this._sourceFile = path;
		this.verifyBreakpoints(path);

		// send to the remote process
		this.sendBreakPoint()

		return bp;
	}

	public async sendBreakPoint() {
		if (this.synchronise.isConnected) {
			const breakpoints = this._breakPoints.get(this._sourceFile);
			if (breakpoints) {
				for (let i = 0; i < breakpoints.length; i++) {
					this.ws.send("setBreakPoints|" + (breakpoints[i].line + 1).toString())
					await this.sleep(200)
				}
			}
			await this.sleep(100)
		}
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): MvonBreakpoint | undefined {
		let bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
		if (this.synchronise.isConnected) {
			this.ws.send("clearBreakPoints")
		}
	}

	// private methods

	private loadSource(file: string) {
		if (this._sourceFile !== file) {
			this._sourceFile = file;
			//this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	/*private run(reverse = false, stepEvent?: string) {
		let fileName = this._sourceFile.substr(0, 2).toUpperCase() + this._sourceFile.substr(2)
		this._sourceFile = fileName
		let bp = this._breakPoints.get(this._sourceFile)

		if (reverse) {
			for (let ln = this._currentLine - 1; ln >= 0; ln--) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return;
				}
			}
			// no more lines: stop at first line
			this._currentLine = 0;
			this.sendEvent('stopOnEntry');
		} else {
			for (let ln = this._currentLine + 1; ln < this._sourceLines.length; ln++) {
				if (this.fireEventsForLine(ln, stepEvent)) {
					this._currentLine = ln;
					return true;
				}
				if (bp !== undefined) {
					for (let i = 0; i < bp.length; i++) {
						if (bp[i].line === ln) {
							return true;
						}
					}
				}
			}
			if (this._currentLine <= this._sourceLines.length) { return true; }
			if (this.synchronise.lastLineProcessed === false) {
				this.synchronise.lastLineProcessed = true
				this.sendEvent("stopOnStep");
				return true;
			}
			// no more lines: run to end
			this.disconnect();
			this.sendEvent('end');
		}
	}*/

	private verifyBreakpoints(path: string): void {
		let bps = this._breakPoints.get(path);
		if (bps) {
			//this.loadSource(path);
			bps.forEach(bp => {
				bp.verified = true;
				this.sendEvent('breakpointValidated', bp);
				/*if (!bp.verified && bp.line < this._sourceLines.length) {
					const srcLine = this._sourceLines[bp.line].trim();

					// if a line is empty or starts with '+' we don't allow to set a breakpoint but move the breakpoint down
					if (srcLine.length === 0 || srcLine.indexOf('+') === 0) {
						bp.line++;
					}
					// if a line starts with '-' we don't allow to set a breakpoint but move the breakpoint up
					if (srcLine.indexOf('-') === 0) {
						bp.line--;
					}
					// don't set 'verified' to true if the line contains the word 'lazy'
					// in this case the breakpoint will be verified 'lazy' after hitting it once.
					if (srcLine.indexOf('lazy') < 0) {
						bp.verified = true;
						this.sendEvent('breakpointValidated', bp);
					}
				}*/
			});
		}
	}

	/**
	 * Fire events if line has a breakpoint or the word 'exception' is found.
	 * Returns true is execution needs to stop.
	 */
	/*private fireEventsForLine(ln: number, stepEvent?: string): boolean {

		const line = this._sourceLines[ln].trim();

		// if 'log(...)' found in source -> send argument to debug console
		const matches = /log\((.*)\)/.exec(line);
		if (matches && matches.length === 2) {
			this.sendEvent('output', matches[1], this._sourceFile, ln, matches.index)
		}

		// if word 'exception' found in source -> throw exception
		if (line.indexOf('exception') >= 0) {
			this.sendEvent('stopOnException');
			return true;
		}

		// is there a breakpoint?
		const breakpoints = this._breakPoints.get(this._sourceFile);
		if (breakpoints) {
			const bps = breakpoints.filter(bp => bp.line === ln);
			if (bps.length > 0) {

				// send 'stopped' event
				this.synchronise.lastLineProcessed = false
				this.sendEvent('stopOnBreakpoint');

				// the following shows the use of 'breakpoint' events to update properties of a breakpoint in the UI
				// if breakpoint is not yet verified, verify it now and send a 'breakpoint' update event
				if (!bps[0].verified) {
					bps[0].verified = true;
					this.sendEvent('breakpointValidated', bps[0]);
				}
				return true;
			}
		}

		// non-empty line
		if (stepEvent && line.length > 0) {
			this.sendEvent(stepEvent);
			return true;
		}

		// nothing interesting found -> continue
		return false;
	}*/

	private sendEvent(event: string, ...args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
	dispose() {

	}
}