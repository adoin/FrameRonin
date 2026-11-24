import { useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Button, Card, Flex, Input, Radio, Typography } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useLanguage } from '../i18n/context'
import { useImageStash } from '../stash/context'
import { generateImage, ImageRequestError, imageRequestErrorText, RELAY_URL, UPSTREAM_URL, type ImageMode, type RelaySession } from '../lib/imageRelay'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: 'grid', gap: 6 }}>{label}{children}</label>
}

interface Props {
  onBack: () => void
  session: RelaySession | null
  onSessionExpired: (token: string) => void
  onOpenAccount: () => void
}

export default function ImageGeneration({ onBack, session, onSessionExpired, onOpenAccount }: Props) {
  const { t } = useLanguage()
  const { addImage } = useImageStash()
  const [relaySelected, setRelaySelected] = useState(true)
  const [mode, setMode] = useState<ImageMode>('images')
  const [host, setHost] = useState(UPSTREAM_URL)
  const [image, setImage] = useState('')
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [imageError, setImageError] = useState('')
  const canRelay = !!session && !session.changeRequired
  const throughRelay = canRelay && relaySelected

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    const apiKey = String(form.get('apiKey') ?? '').trim().replace(/^Bearer\s+/i, '')
    const model = String(form.get('model') ?? '').trim()
    const prompt = String(form.get('prompt') ?? '').trim()
    if (!apiKey || !model || !prompt) {
      setImageError(t('relayError_invalid_input'))
      return
    }
    setBusy(true)
    setImageError('')
    setImage('')
    setAdded(false)
    try {
      setImage(await generateImage({ apiKey, mode, model, prompt }, host.trim(), throughRelay ? session?.token : undefined))
    } catch (error) {
      if (error instanceof ImageRequestError && error.code === 'login_required' && session) {
        onSessionExpired(session.token)
      }
      setImageError(imageRequestErrorText(error, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <Flex vertical gap="middle">
        <div><Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>{t('backToHome')}</Button></div>
        <Typography.Title level={2} style={{ margin: 0 }}>{t('relayTitle')}</Typography.Title>
        <form onSubmit={generate}>
          <Flex vertical gap="middle">
            <Flex gap="small" align="center" wrap>
              <Radio.Group aria-label={t('relayConnection')} value={throughRelay ? 'relay' : 'direct'} onChange={(event) => setRelaySelected(event.target.value === 'relay')} disabled={busy}>
                <Radio.Button value="direct">{t('relayDirect')}</Radio.Button>
                {RELAY_URL && <Radio.Button value="relay" disabled={!canRelay}>{t('relayViaServer')}</Radio.Button>}
              </Radio.Group>
              {RELAY_URL && !canRelay && (
                <Button type="link" onClick={onOpenAccount}>{t(session ? 'relayChangePassword' : 'relaySignIn')}</Button>
              )}
            </Flex>
            <Field label="Host"><Input type="url" value={throughRelay ? UPSTREAM_URL : host} onChange={(event) => setHost(event.target.value)} disabled={throughRelay} autoComplete="off" required /></Field>
            <Field label="API Key"><Input.Password name="apiKey" autoComplete="off" maxLength={512} required /></Field>
            <Radio.Group aria-label={t('relayApiMode')} value={mode} onChange={(event) => setMode(event.target.value)} disabled={!!busy}>
              <Radio value="images">Images API</Radio>
              <Radio value="chat">Chat Completions</Radio>
            </Radio.Group>
            <Field label="Model"><Input name="model" defaultValue="gpt-image-2.5-flare" autoComplete="off" maxLength={128} required /></Field>
            <Field label={t('relayPrompt')}><Input.TextArea name="prompt" rows={4} maxLength={4000} required /></Field>
            {imageError && <Alert type="error" message={imageError} />}
            <div><Button type="primary" htmlType="submit" loading={busy}>{t('relayGenerate')}</Button></div>
          </Flex>
        </form>
        {image && (
          <Flex vertical gap="small" align="start">
            <img src={image} alt={t('relayResult')} referrerPolicy="no-referrer" style={{ maxWidth: '100%', maxHeight: 650, objectFit: 'contain' }} />
            <Button disabled={added} onClick={() => { addImage(image, 'AI image'); setAdded(true) }}>{t(added ? 'relayAdded' : 'relayAdd')}</Button>
          </Flex>
        )}
      </Flex>
    </Card>
  )
}
