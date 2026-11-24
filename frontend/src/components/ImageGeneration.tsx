import { useState, type FormEvent, type ReactNode } from 'react'
import { Alert, Button, Card, Flex, Input, Radio, Typography } from 'antd'
import { ArrowLeftOutlined } from '@ant-design/icons'
import { useLanguage } from '../i18n/context'
import { useImageStash } from '../stash/context'
import { generateImage, ImageRequestError, relayRequest, RELAY_URL, signIn, UPSTREAM_URL, type ImageMode, type RelaySession } from '../lib/imageRelay'

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label style={{ display: 'grid', gap: 6 }}>{label}{children}</label>
}

interface Props {
  onBack: () => void
  session: RelaySession | null
  setSession: (session: RelaySession | null) => void
}

export default function ImageGeneration({ onBack, session, setSession }: Props) {
  const { t } = useLanguage()
  const { addImage } = useImageStash()
  const [showSetup, setShowSetup] = useState(false)
  const [changing, setChanging] = useState(false)
  const [relaySelected, setRelaySelected] = useState(true)
  const [mode, setMode] = useState<ImageMode>('images')
  const [host, setHost] = useState(UPSTREAM_URL)
  const [image, setImage] = useState('')
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState<'auth' | 'generate' | null>(null)
  const [authError, setAuthError] = useState('')
  const [imageError, setImageError] = useState('')
  const canRelay = !!session && !session.changeRequired
  const throughRelay = canRelay && relaySelected

  function errorText(error: unknown) {
    if (!(error instanceof ImageRequestError)) return t('relayError_generic')
    const key = `relayError_${error.code}`
    const translated = t(key)
    const text = translated === key ? t('relayError_generic') : translated
    return error.status ? `${text} (HTTP ${error.status})` : text
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    setBusy('auth')
    setAuthError('')
    try {
      if (session) {
        await relayRequest('/password', { password: form.get('password'), newPassword: form.get('newPassword') }, session.token)
        setSession(null)
        setChanging(false)
        setShowSetup(false)
        setAuthError(t('relayPasswordUpdated'))
      } else {
        setSession(await signIn(String(form.get('username') ?? '').trim(), String(form.get('password') ?? ''), String(form.get('setupCode') ?? '').trim()))
        setShowSetup(false)
        setRelaySelected(true)
      }
    } catch (error) {
      if (error instanceof ImageRequestError && error.code === 'setup_code_required') setShowSetup(true)
      if (error instanceof ImageRequestError && error.code === 'login_required') setSession(null)
      setAuthError(errorText(error))
    } finally {
      setBusy(null)
    }
  }

  async function signOut() {
    if (!session || busy) return
    setBusy('auth')
    setAuthError('')
    try {
      await relayRequest('/logout', {}, session.token)
    } catch (error) {
      if (!(error instanceof ImageRequestError && error.code === 'login_required')) {
        setAuthError(errorText(error))
        return
      }
    } finally {
      setBusy(null)
    }
    setSession(null)
    setChanging(false)
  }

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
    setBusy('generate')
    setImageError('')
    setImage('')
    setAdded(false)
    try {
      setImage(await generateImage({ apiKey, mode, model, prompt }, host.trim(), throughRelay ? session?.token : undefined))
    } catch (error) {
      if (error instanceof ImageRequestError && error.code === 'login_required') setSession(null)
      setImageError(errorText(error))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <Flex vertical gap="middle">
        <div><Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>{t('backToHome')}</Button></div>
        <Typography.Title level={2} style={{ margin: 0 }}>{t('relayTitle')}</Typography.Title>
        {RELAY_URL && (
          <Card size="small" title={t('relayAccount')}>
            <Flex vertical gap="small">
              {authError && <Alert type={authError === t('relayPasswordUpdated') ? 'success' : 'error'} message={authError} />}
              {(!session || session.changeRequired || changing) && (
                <form key={session ? 'password' : 'login'} onSubmit={authenticate}>
                  <Flex vertical gap="small" style={{ maxWidth: 380 }}>
                    {!session && <Field label={t('relayUsername')}><Input name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue="adoin" required /></Field>}
                    {session?.changeRequired && <Typography.Text>{t('relayFirstPassword')}</Typography.Text>}
                    <Field label={t(session ? 'relayCurrentPassword' : 'relayPassword')}>
                      <Input.Password name="password" autoComplete="current-password" required maxLength={256} />
                    </Field>
                    {!session && showSetup && <Field label={t('relaySetupCode')}><Input.Password name="setupCode" autoComplete="one-time-code" required /></Field>}
                    {session && <Field label={t('relayNewPassword')}><Input.Password name="newPassword" autoComplete="new-password" minLength={12} maxLength={256} required /></Field>}
                    <Flex gap="small" wrap>
                      <Button type="primary" htmlType="submit" loading={busy === 'auth'} disabled={busy === 'generate'}>{t(session ? 'relayChangePassword' : 'relaySignIn')}</Button>
                      {changing && <Button onClick={() => setChanging(false)} disabled={!!busy}>{t('relayCancel')}</Button>}
                    </Flex>
                  </Flex>
                </form>
              )}
              {session && !session.changeRequired && !changing && (
                <Flex gap="small" align="center" wrap>
                  <Typography.Text strong>adoin</Typography.Text>
                  <Button onClick={() => { setAuthError(''); setChanging(true) }} disabled={!!busy}>{t('relayChangePassword')}</Button>
                  <Button onClick={() => void signOut()} disabled={!!busy}>{t('relaySignOut')}</Button>
                </Flex>
              )}
            </Flex>
          </Card>
        )}
        <form onSubmit={generate}>
          <Flex vertical gap="middle">
            <Radio.Group aria-label={t('relayConnection')} value={throughRelay ? 'relay' : 'direct'} onChange={(event) => setRelaySelected(event.target.value === 'relay')} disabled={!!busy}>
              <Radio.Button value="direct">{t('relayDirect')}</Radio.Button>
              {RELAY_URL && <Radio.Button value="relay" disabled={!canRelay}>{t('relayViaServer')}</Radio.Button>}
            </Radio.Group>
            <Field label="Host"><Input type="url" value={throughRelay ? UPSTREAM_URL : host} onChange={(event) => setHost(event.target.value)} disabled={throughRelay} autoComplete="off" required /></Field>
            <Field label="API Key"><Input.Password name="apiKey" autoComplete="off" maxLength={512} required /></Field>
            <Radio.Group aria-label={t('relayApiMode')} value={mode} onChange={(event) => setMode(event.target.value)} disabled={!!busy}>
              <Radio value="images">Images API</Radio>
              <Radio value="chat">Chat Completions</Radio>
            </Radio.Group>
            <Field label="Model"><Input name="model" defaultValue="gpt-image-2.5-flare" autoComplete="off" maxLength={128} required /></Field>
            <Field label={t('relayPrompt')}><Input.TextArea name="prompt" rows={4} maxLength={4000} required /></Field>
            {imageError && <Alert type="error" message={imageError} />}
            <div><Button type="primary" htmlType="submit" loading={busy === 'generate'} disabled={busy === 'auth'}>{t('relayGenerate')}</Button></div>
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
