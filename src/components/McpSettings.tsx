import { useEffect, useState } from 'react';
import { Copy, Check, Cable } from 'lucide-react';
import type { McpStatus } from '../bridge';
export default function McpSettings() {
  const [status, setStatus] = useState<McpStatus | null>(null),
    [port, setPort] = useState('47831'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [copied, setCopied] = useState('');
  useEffect(() => {
    window.canvas
      ?.mcpStatus()
      .then((s) => {
        setStatus(s);
        setPort(String(s.port));
      })
      .catch((e) => setError(String(e)));
  }, []);
  const update = async (enabled: boolean) => {
    setBusy(true);
    setError('');
    try {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1024 || p > 65535)
        throw Error('Choose a port between 1024 and 65535.');
      setStatus(await window.canvas!.mcpUpdate({ enabled, port: p }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (name: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(name);
    } catch {
      setError('Could not copy. Select and copy the configuration below.');
    }
  };
  return (
    <div className="mcp-settings">
      <div className="mcp-heading">
        <span className="mcp-symbol">
          <Cable size={24} />
        </span>
        <div>
          <h3>Connect your AI</h3>
          <p>Let Codex or Claude work with your boards.</p>
        </div>
      </div>
      <div className="mcp-access">
        <div>
          <strong>AI access via MCP</strong>
          <p>Read and edit all boards, organize folders, and import photos.</p>
        </div>
        <button
          role="switch"
          aria-label="Enable MCP server"
          aria-checked={!!status?.enabled}
          className="mcp-switch"
          disabled={busy || !status}
          onClick={() => update(!status?.enabled)}
        >
          <span />
        </button>
      </div>
      <div className="mcp-state">
        <span className={'mcp-dot ' + (status?.running ? 'running' : '')} />
        {status?.running
          ? 'Running on this computer'
          : status?.enabled
            ? 'Server could not start'
            : 'Disabled'}
        {status?.running && <code>{status.url}</code>}
      </div>
      {(error || status?.error) && (
        <p className="mcp-error" role="alert">
          {error || status?.error}
        </p>
      )}
      <p className="quiet">
        Keep Terra Board open while connected. Turning access off blocks new AI requests. Changes
        already saved remain on your boards.
      </p>
      <label className="mcp-port">
        Local port{' '}
        <input
          aria-label="MCP port"
          type="number"
          min="1024"
          max="65535"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <button
          className="button"
          disabled={busy || !status || Number(port) === status.port}
          onClick={() => update(!!status?.enabled)}
        >
          Apply
        </button>
      </label>
      {status && (
        <div className="mcp-clients">
          <details open>
            <summary>Codex</summary>
            <p>
              Add this entry to your Codex MCP configuration. It contains your private access token.
            </p>
            <textarea
              aria-label="Codex MCP configuration"
              readOnly
              value={status.codexConfig}
              rows={3}
            />
            <button className="button" onClick={() => copy('Codex', status.codexConfig)}>
              {copied === 'Codex' ? <Check size={15} /> : <Copy size={15} />}Copy Codex
              configuration
            </button>
          </details>
          <details>
            <summary>Claude Desktop</summary>
            <p>
              Add the terra_board entry to mcpServers in your Claude Desktop configuration, then
              restart Claude. The bundled connector needs no separate Node installation.
            </p>
            <textarea
              aria-label="Claude MCP configuration"
              readOnly
              value={status.claudeConfig}
              rows={9}
            />
            <button className="button" onClick={() => copy('Claude', status.claudeConfig)}>
              {copied === 'Claude' ? <Check size={15} /> : <Copy size={15} />}Copy Claude
              configuration
            </button>
          </details>
        </div>
      )}
    </div>
  );
}
