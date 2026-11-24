import { useState, type FormEvent } from 'react'
import { Alert, Button, Flex, Input, Modal, Typography } from 'antd'
import { useLanguage } from '../i18n/context'
import { ImageRequestError, imageRequestErrorText, relayRequest, signIn, type RelaySession } from '../lib/imageRelay'

interface Props {
  open: boolean
  onClose: () => void
  session: RelaySession | null
  setSession: (session: RelaySession | null) => void
}

function AccountForm({ onClose, session, setSession }: Omit<Props, 'open'>) {
  const { t } = useLanguage()
  const [showSetup, setShowSetup] = useState(false)
  const [changing, setChanging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [passwordUpdated, setPasswordUpdated] = useState(false)

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = new FormData(event.currentTarget)
    setBusy(true)
    setError(null)
    setPasswordUpdated(false)
    try {
      if (session) {
        await relayRequest('/password', { password: form.get('password'), newPassword: form.get('newPassword') }, session.token)
        setSession(null)
        setChanging(false)
        setShowSetup(false)
        setPasswordUpdated(true)
      } else {
        const next = await signIn(String(form.get('username') ?? '').trim(), String(form.get('password') ?? ''), String(form.get('setupCode') ?? '').trim())
        setSession(next)
        setShowSetup(false)
        if (!next.changeRequired) onClose()
      }
    } catch (failure) {
      if (failure instanceof ImageRequestError && failure.code === 'setup_code_required') setShowSetup(true)
      if (failure instanceof ImageRequestError && failure.code === 'login_required') {
        setSession(null)
        setChanging(false)
      }
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    if (!session || busy) return
    setBusy(true)
    setError(null)
    try {
      await relayRequest('/logout', {}, session.token)
    } catch (failure) {
      if (!(failure instanceof ImageRequestError && failure.code === 'login_required')) {
        setError(failure)
        return
      }
    } finally {
      setBusy(false)
    }
    setSession(null)
    onClose()
  }

  const hasSession = session && !session.changeRequired && !changing
  return (
    <Flex vertical gap="middle">
      {error != null && <Alert type="error" message={imageRequestErrorText(error, t)} />}
      {passwordUpdated && <Alert type="success" message={t('relayPasswordUpdated')} />}
      {hasSession ? (
        <Flex gap="small" align="center" wrap>
          <Typography.Text strong>adoin</Typography.Text>
          <Button onClick={() => { setError(null); setChanging(true) }} disabled={busy}>{t('relayChangePassword')}</Button>
          <Button onClick={() => void signOut()} loading={busy}>{t('relaySignOut')}</Button>
        </Flex>
      ) : (
        <form key={session ? 'password' : 'login'} onSubmit={authenticate}>
          <Flex vertical gap="small">
            {!session && (
              <div>
                <label htmlFor="relay-username">{t('relayUsername')}</label>
                <Input id="relay-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} defaultValue="adoin" required />
              </div>
            )}
            {session?.changeRequired && <Typography.Text>{t('relayFirstPassword')}</Typography.Text>}
            <div>
              <label htmlFor="relay-current-password">{t(session ? 'relayCurrentPassword' : 'relayPassword')}</label>
              <Input.Password id="relay-current-password" name="password" autoComplete="current-password" required maxLength={256} />
            </div>
            {!session && showSetup && (
              <div>
                <label htmlFor="relay-setup-code">{t('relaySetupCode')}</label>
                <Input.Password id="relay-setup-code" name="setupCode" autoComplete="one-time-code" required />
              </div>
            )}
            {session && (
              <div>
                <label htmlFor="relay-new-password">{t('relayNewPassword')}</label>
                <Input.Password id="relay-new-password" name="newPassword" autoComplete="new-password" minLength={12} maxLength={256} required />
              </div>
            )}
            <Flex gap="small" wrap>
              <Button type="primary" htmlType="submit" loading={busy}>{t(session ? 'relayChangePassword' : 'relaySignIn')}</Button>
              {changing && <Button onClick={() => { setError(null); setChanging(false) }} disabled={busy}>{t('relayCancel')}</Button>}
            </Flex>
          </Flex>
        </form>
      )}
    </Flex>
  )
}

export default function RelayAccountDialog({ open, onClose, ...account }: Props) {
  const { t } = useLanguage()
  return (
    <Modal title={t('relayAccount')} open={open} onCancel={onClose} footer={null} centered destroyOnHidden width={420}>
      <AccountForm {...account} onClose={onClose} />
    </Modal>
  )
}
