package io.orkoswap.orkowallet

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/**
 * Keeps the app process (and with it the wallet's Tor onion address) alive while a wallet is open, so
 * payments can arrive with the screen off. Android allows that only with a visible foreground-service
 * notification. It stops when the wallet is closed or the app is swiped away from the recent apps.
 * The notification has a "Close wallet" button that shuts the wallet down and ends the app.
 */
class OrkoService : Service() {
  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_QUIT) {
      val act = MainActivity.current?.get()
      if (act != null) {
        act.runOnUiThread { act.quitFromNotification() }
      } else {
        // No page left to close the wallet cleanly: stop and end the process.
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        android.os.Process.killProcess(android.os.Process.myPid())
      }
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra("title") ?: "OrkoWallet"
    val text = intent?.getStringExtra("text") ?: ""
    val closeLabel = intent?.getStringExtra("close") ?: "Close wallet"
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
      val ch = NotificationChannel(CHANNEL, "OrkoWallet", NotificationManager.IMPORTANCE_LOW)
      ch.setShowBadge(false)
      nm.createNotificationChannel(ch)
    }
    val open = PendingIntent.getActivity(
      this, 0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val quit = PendingIntent.getService(
      this, 1,
      Intent(this, OrkoService::class.java).setAction(ACTION_QUIT),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    val n = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle(title)
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setContentIntent(open)
      .addAction(0, closeLabel, quit)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(ID, n)
    }
    if (wake == null) {
      // The CPU must stay awake for Tor to keep its circuits and answer incoming payments.
      wake = getSystemService(PowerManager::class.java)
        .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "orkowallet:tor")
        .also { it.setReferenceCounted(false); it.acquire() }
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }

  companion object {
    const val CHANNEL = "orko_keepalive"
    const val ID = 4711
    const val ACTION_QUIT = "io.orkoswap.orkowallet.QUIT"
  }
}
