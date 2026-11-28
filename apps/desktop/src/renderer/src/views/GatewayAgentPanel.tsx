import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  InferenceResult,
  ModelDefinition,
  ModelRoute,
  ProviderConnection,
} from '@devbrain/contracts';
import { Badge, Banner, Button, Field, Select, Textarea, UntrustedBlock } from '@devbrain/ui';
import { callAiChannel } from '../lib/ai-center';
import type { AppLanguage } from '../lib/i18n';

interface GatewayAgentPanelProps {
  projectId: string;
  language: AppLanguage;
}

/** Native inference in the workspace. It has no file or command tools. */
export const GatewayAgentPanel = ({ projectId, language }: GatewayAgentPanelProps) => {
  const pt = language === 'pt-BR';
  const [models, setModels] = useState<ModelDefinition[]>([]);
  const [routes, setRoutes] = useState<ModelRoute[]>([]);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [modelId, setModelId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<InferenceResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [modelOut, routeOut, connectionOut] = await Promise.all([
      callAiChannel('ai.models.list', {}),
      callAiChannel('ai.routes.list', {}),
      callAiChannel('ai.connections.list', {}),
    ]);
    if (modelOut.status === 'ok') setModels(modelOut.data);
    if (routeOut.status === 'ok') setRoutes(routeOut.data);
    if (connectionOut.status === 'ok') setConnections(connectionOut.data);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, projectId]);

  const eligible = useMemo(
    () =>
      models.filter(
        (model) =>
          model.capabilities.input.includes('text') &&
          model.capabilities.output.includes('text') &&
          routes.some(
            (route) =>
              route.modelId === model.id &&
              route.enabled &&
              connections.some(
                (connection) =>
                  connection.id === route.connectionId &&
                  connection.status === 'ready' &&
                  connection.enabled,
              ),
          ),
      ),
    [models, routes, connections],
  );

  useEffect(() => {
    if (!eligible.some((model) => model.id === modelId)) setModelId(eligible[0]?.id ?? '');
  }, [eligible, modelId]);

  const run = async () => {
    if (!modelId || !prompt.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const policyId = `policy-project-${projectId}`;
      const request = {
        id: `req-native-${crypto.randomUUID()}`,
        sessionId: null,
        modelId,
        messages: [{ role: 'user' as const, content: prompt.trim() }],
        maxOutputTokens: 1024,
        temperature: 0.2,
        stream: false,
        routingPolicyId: policyId,
        idempotencyKey: null,
        projectId,
      };
      const explained = await callAiChannel('ai.routes.explain', request);
      if (explained.status !== 'ok')
        throw new Error(explained.status === 'error' ? explained.error.message : explained.message);
      if (explained.data.ranked.length === 0) {
        const why = explained.data.excluded.flatMap((item) =>
          item.reasons.map((reason) => reason.message),
        );
        throw new Error(why.join('; ') || 'No eligible route for this project');
      }
      const submitted = await callAiChannel('ai.inference.submit', request);
      if (submitted.status !== 'ok')
        throw new Error(submitted.status === 'error' ? submitted.error.message : submitted.message);
      for (let attempt = 0; attempt < 120; attempt++) {
        const read = await callAiChannel('ai.inference.result', {
          requestId: submitted.data.requestId,
        });
        if (read.status === 'error') throw new Error(read.error.message);
        if (read.status === 'ok' && read.data) {
          setResult(read.data);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error('No confirmed result; inspect gateway diagnostics');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="db-card"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        overflowY: 'auto',
        maxHeight: 320,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>
          {pt ? 'Conversa direta · modelos do gateway' : 'Direct chat · gateway models'}
        </strong>
        <Button size="xs" variant="secondary" onClick={() => void refresh()}>
          {pt ? 'Atualizar' : 'Refresh'}
        </Button>
      </div>
      <div className="db-muted" style={{ fontSize: 11 }}>
        {pt
          ? 'Inferência nativa sob política do projeto. Esta conversa não edita arquivos nem executa comandos.'
          : 'Native inference under project policy. This conversation does not edit files or run commands.'}
      </div>
      <Field
        label={pt ? 'Modelo com conexão e rota ativas' : 'Model with active connection and route'}
      >
        {(props) => (
          <Select {...props} value={modelId} onChange={(event) => setModelId(event.target.value)}>
            <option value="">{pt ? 'Selecione' : 'Select'}</option>
            {eligible.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name} [{model.providerId}] {model.capabilities.tools ? '· tools' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {eligible.length === 0 ? (
        <Banner tone="info">
          {pt
            ? 'Nenhuma rota autenticada disponível. Conecte um provedor na Central de IA.'
            : 'No authenticated route. Connect a provider in the AI Resource Center.'}
        </Banner>
      ) : null}
      <Textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder={pt ? 'Pergunte ao modelo selecionado…' : 'Ask the selected model…'}
        style={{ minHeight: 56 }}
      />
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        disabled={!modelId || !prompt.trim()}
        onClick={() => void run()}
      >
        {pt ? 'Enviar ao gateway' : 'Send to gateway'}
      </Button>
      {error ? <Banner tone="danger">{error}</Banner> : null}
      {result ? (
        <>
          <Badge tone="success">{result.routeId}</Badge>
          <UntrustedBlock
            label={pt ? 'Resposta do modelo' : 'Model response'}
            text={result.content}
          />
        </>
      ) : null}
    </div>
  );
};
