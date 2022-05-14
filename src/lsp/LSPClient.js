import GLib from "gi://GLib";
import Gio from "gi://Gio";

import { promiseTask, once } from "../troll/src/util.js";

const { addSignalMethods } = imports.signals;

export default class LSPClient {
  constructor(argv) {
    this.argv = argv;
  }

  start() {
    const proc = Gio.Subprocess.new(
      this.argv,
      Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE
    );

    const stdin = proc.get_stdin_pipe();
    const stdout = new Gio.DataInputStream({
      base_stream: proc.get_stdout_pipe(),
      close_base_stream: true,
    });
    Object.assign(this, { proc, stdin, stdout });

    this._read();

    proc.wait_async(null, (proc, res) => {
      try {
        proc.wait_finish(res);
      } catch (e) {
        logError(e);
      }
      this.emit("exit");
    });
  }

  _read() {
    const that = this;
    function readOutput() {
      that.stdout.read_line_async(0, null, (self, res) => {
        let line;
        try {
          [line] = that.stdout.read_line_finish_utf8(res);
        } catch (err) {
          logError(err);
          return;
        }

        if (line === null) return;
        if (line.startsWith("{")) {
          try {
            that._onmessage(JSON.parse(line));
            // eslint-disable-next-line no-empty
          } catch (err) {
            console.log(err);
          }
        }

        readOutput();
      });
    }
    readOutput();
  }

  _onmessage(message) {
    this.emit("input", message);

    if (message.result) {
      this.emit(`result::${message.id}`, message.result);
    }
    if (message.error) {
      const err = new Error(message.error.message);
      err.data = message.data;
      err.code = message.code;
      this.emit(`error::${message.id}`, err);
    }
  }

  async send(json) {
    const message = { ...json, jsonrpc: "2.0" };
    const str = JSON.stringify(message);
    const length = [...str].length;

    if (this.stdin.clear_pending()) {
      this.stdin.flush();
    }

    await promiseTask(
      this.stdin,
      "write_bytes_async",
      "write_bytes_finish",
      new GLib.Bytes(`Content-Length: ${length}\r\n\r\n${str}`),
      GLib.PRIORITY_DEFAULT,
      null
    );

    this.emit("output", message);
  }

  async request(method, params = {}) {
    const id = rid();
    await this.send({
      id,
      method,
      params,
    });
    const [result] = await once(this, `result::${id}`, {
      error: `error::${id}`,
      timeout: 1000,
    });
    return result;
  }

  async notify(method, params = {}) {
    return this.send({
      method,
      params,
    });
  }
}
addSignalMethods(LSPClient.prototype);

function rid() {
  return Math.random().toString().substring(2);
}