package expo.modules.t3agentnotifications

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import com.facebook.react.modules.network.OkHttpClientFactory
import com.facebook.react.modules.network.OkHttpClientProvider
import java.io.IOException
import java.net.InetAddress
import java.net.Socket
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.Collections
import java.util.WeakHashMap
import javax.net.SocketFactory
import okhttp3.Dns
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient

/** Companion-only LAN policy in the actual HTTP/WebSocket transport; TLS remains Android's normal verifier. */
object SandboxLanTransport {
  private var installed = false
  private var connectivity: ConnectivityManager? = null
  @Volatile private var origin: HttpUrl? = null
  @Volatile private var viewToken: String? = null
  private val clients = Collections.newSetFromMap(WeakHashMap<OkHttpClient, Boolean>())
  private val sockets = Collections.newSetFromMap(WeakHashMap<Socket, Boolean>())
  @Volatile private var boundNetwork: Network? = null

  @Synchronized fun install(context: Context) {
    if (installed || context.packageName != "org.olemartin.sandbox.companion") return
    installed = true
    connectivity = context.getSystemService(ConnectivityManager::class.java)
    OkHttpClientProvider.setOkHttpClientFactory(OkHttpClientFactory {
      val client = OkHttpClientProvider.createClientBuilder()
        .followRedirects(false).followSslRedirects(false).proxy(Proxy.NO_PROXY)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
        .dns(object : Dns {
          override fun lookup(hostname: String): List<InetAddress> {
          val configured = origin ?: throw IOException("No Sandbox host selected")
          if (!hostname.equals(configured.host, true)) throw IOException("Host is outside selected Sandbox origin")
          val network = lanNetwork()
          val addresses = network.getAllByName(hostname).toList()
          if (addresses.isEmpty() || addresses.any { !onLink(network, it) }) throw IOException("Sandbox host is not on the connected LAN")
          return addresses
          }
        })
        .socketFactory(object : SocketFactory() {
          override fun createSocket(): Socket = remember(lanNetwork().socketFactory.createSocket())
          override fun createSocket(host: String, port: Int): Socket = throw IOException("Sandbox connections must use validated DNS")
          override fun createSocket(host: String, port: Int, local: InetAddress, localPort: Int): Socket = throw IOException("Sandbox connections must use validated DNS")
          override fun createSocket(address: InetAddress, port: Int): Socket { val network = lanNetwork(); requireOnLink(network, address); return remember(network.socketFactory.createSocket(address, port)) }
          override fun createSocket(address: InetAddress, port: Int, local: InetAddress, localPort: Int): Socket { val network = lanNetwork(); requireOnLink(network, address); return remember(network.socketFactory.createSocket(address, port, local, localPort)) }
        })
        .addInterceptor { chain ->
          val configured = origin ?: throw IOException("No Sandbox host selected")
          val request = chain.request()
          if (request.url.scheme != configured.scheme || !request.url.host.equals(configured.host, true) || request.url.port != configured.port) throw IOException("Request is outside selected Sandbox origin")
          val network = lanNetwork()
          val addresses = network.getAllByName(request.url.host)
          if (addresses.isEmpty() || addresses.any { !onLink(network, it) }) throw IOException("Sandbox host is not on the connected LAN")
          val scoped = viewToken
          if (!request.url.encodedPath.startsWith("/api/v1/") && scoped != null) chain.proceed(request.newBuilder().removeHeader("Authorization").header("x-sandbox-view-token", scoped).build()) else chain.proceed(request)
        }
        .addNetworkInterceptor { chain ->
          val address = chain.connection()?.route()?.socketAddress?.address ?: throw IOException("Sandbox route is unknown")
          requireOnLink(lanNetwork(), address)
          chain.proceed(chain.request())
        }.build()
      synchronized(clients) { clients.add(client) }
      client
    })
    connectivity?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onLost(network: Network) { if (network == boundNetwork) { boundNetwork = null; cancel() } }
      override fun onAvailable(network: Network) { if (network != boundNetwork) { boundNetwork = network; cancel() } }
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        if (network == boundNetwork && (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)))) cancel()
      }
      override fun onLinkPropertiesChanged(network: Network, properties: android.net.LinkProperties) { if (network == boundNetwork) cancel() }
    })
  }
  fun setViewToken(value: String?) { viewToken = value }
  fun select(value: String?) {
    val next = value?.let(::parseOrigin)
    if (origin?.toString() != next?.toString()) { viewToken = null; origin = next; cancel() }
  }
  internal fun parseOrigin(value: String): HttpUrl = value.toHttpUrl().also {
    require(it.scheme in setOf("http", "https") && it.encodedUsername.isEmpty() && it.encodedPassword.isEmpty() && it.query == null && it.fragment == null && it.encodedPath == "/") { "Sandbox requires a LAN HTTP or HTTPS origin" }
  }
  private fun remember(socket: Socket): Socket { synchronized(sockets) { sockets.add(socket) }; return socket }
  private fun cancel() {
    synchronized(clients) { clients.forEach { it.dispatcher.cancelAll(); it.connectionPool.evictAll() } }
    synchronized(sockets) { sockets.toList().forEach { try { it.close() } catch (_: IOException) {} }; sockets.clear() }
  }
  private fun lanNetwork(): Network {
    val manager = connectivity ?: throw IOException("Sandbox LAN transport is unavailable")
    val network = manager.activeNetwork ?: throw IOException("No connected LAN")
    val capabilities = manager.getNetworkCapabilities(network) ?: throw IOException("Unknown network")
    if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN) || (!capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) throw IOException("Sandbox requires Wi-Fi or Ethernet")
    boundNetwork = network
    return network
  }
  internal fun localAddress(address: InetAddress): Boolean {
    if (address.isLoopbackAddress || address.isAnyLocalAddress || address.isMulticastAddress) return false
    val bytes = address.address
    return address.isSiteLocalAddress || address.isLinkLocalAddress || (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc)
  }
  private fun onLink(network: Network, address: InetAddress): Boolean = localAddress(address) && connectivity?.getLinkProperties(network)?.routes?.any { !it.hasGateway() && it.destination.contains(address) } == true
  private fun requireOnLink(network: Network, address: InetAddress) { if (!onLink(network, address)) throw IOException("Sandbox route left the connected LAN") }
}
