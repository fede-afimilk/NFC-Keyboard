package com.nfckeyboard.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

class HIDForegroundService : Service() {

    companion object {
        const val ACTION_START = "com.nfckeyboard.START"
        const val ACTION_STOP = "com.nfckeyboard.STOP"
        private const val CHANNEL_ID = "nfc_keyboard_channel"
        private const val NOTIFICATION_ID = 101
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopForeground(true); stopSelf(); return START_NOT_STICKY }
            else -> showNotification()
        }
        return START_STICKY
    }

    private fun showNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "NFC Keyboard", NotificationManager.IMPORTANCE_LOW
            ).apply { description = "Keeps the Bluetooth keyboard active" }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("NFC Keyboard active")
            .setContentText("Bluetooth HID ready to receive NFC tags")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        startForeground(NOTIFICATION_ID, notification)
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
