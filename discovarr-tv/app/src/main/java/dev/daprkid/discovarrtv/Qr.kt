package dev.daprkid.discovarrtv

/**
 * QR codes, made in the app instead of pulled in from a library.
 *
 * Signing in to Plex from a television ends in a browser: Plex issues the full
 * account token only for a "strong" pin, confirmed on its web authorisation
 * page, and a token from the four-character plex.tv/link code is a limited one
 * that plex.tv refuses at `/api/v2/user` and `/api/v2/home/users` — the very
 * call the server makes to list a household's profiles. That page's URL is far
 * too long for a remote control, so the television draws it as a code a phone
 * can scan, and this is the encoder that draws it.
 *
 * A deliberate subset, because the app carries no third-party code: byte mode,
 * error correction level M, versions 1 to 15, the smallest that fits, and
 * automatic mask selection.
 */
object Qr {
    class Code(val size: Int, private val modules: BooleanArray) {
        fun isDark(x: Int, y: Int): Boolean = modules[y * size + x]
    }

    /**
     * Error-correction layout per version: codewords of parity per block, then
     * (block count, data codewords) for each group of blocks.
     */
    private val ECC = arrayOf(
        intArrayOf(),
        intArrayOf(10, 1, 16),
        intArrayOf(16, 1, 28),
        intArrayOf(26, 1, 44),
        intArrayOf(18, 2, 32),
        intArrayOf(24, 2, 43),
        intArrayOf(16, 4, 27),
        intArrayOf(18, 4, 31),
        intArrayOf(22, 2, 38, 2, 39),
        intArrayOf(22, 3, 36, 2, 37),
        intArrayOf(26, 4, 43, 1, 44),
        intArrayOf(30, 1, 50, 4, 51),
        intArrayOf(22, 6, 36, 2, 37),
        intArrayOf(22, 8, 37, 1, 38),
        intArrayOf(24, 4, 40, 5, 41),
        intArrayOf(24, 5, 41, 5, 42),
    )

    /** Alignment-pattern centres per version; version 1 has none. */
    private val ALIGN = arrayOf(
        intArrayOf(),
        intArrayOf(),
        intArrayOf(6, 18),
        intArrayOf(6, 22),
        intArrayOf(6, 26),
        intArrayOf(6, 30),
        intArrayOf(6, 34),
        intArrayOf(6, 22, 38),
        intArrayOf(6, 24, 42),
        intArrayOf(6, 26, 46),
        intArrayOf(6, 28, 50),
        intArrayOf(6, 30, 54),
        intArrayOf(6, 32, 58),
        intArrayOf(6, 34, 62),
        intArrayOf(6, 26, 46, 66),
        intArrayOf(6, 26, 48, 70),
    )

    fun encode(text: String): Code {
        val payload = text.toByteArray(Charsets.UTF_8)
        val version = pickVersion(payload.size)
        val capacityBits = dataCodewords(version) * 8

        val bits = BitBuffer()
        bits.append(0b0100, 4)
        bits.append(payload.size, if (version <= 9) 8 else 16)
        for (byte in payload) bits.append(byte.toInt() and 0xFF, 8)
        bits.append(0, minOf(4, capacityBits - bits.size))
        bits.append(0, (8 - bits.size % 8) % 8)
        var alternate = true
        while (bits.size < capacityBits) {
            bits.append(if (alternate) 0xEC else 0x11, 8)
            alternate = !alternate
        }
        val data = bits.toBytes()

        // Split the payload into blocks, add each block's own parity, then
        // interleave: one codeword from every block in turn, data before parity.
        val layout = ECC[version]
        val parity = layout[0]
        val blocks = ArrayList<ByteArray>()
        val parities = ArrayList<ByteArray>()
        var offset = 0
        var group = 1
        while (group + 1 < layout.size) {
            repeat(layout[group]) {
                val block = data.copyOfRange(offset, offset + layout[group + 1])
                offset += layout[group + 1]
                blocks.add(block)
                parities.add(reedSolomon(block, parity))
            }
            group += 2
        }
        val codewords = ByteArray(data.size + parity * blocks.size)
        var index = 0
        val widest = blocks.maxOf { it.size }
        for (position in 0 until widest) {
            for (block in blocks) if (position < block.size) codewords[index++] = block[position]
        }
        for (position in 0 until parity) {
            for (bytes in parities) codewords[index++] = bytes[position]
        }

        val size = version * 4 + 17
        val base = Array(size) { BooleanArray(size) }
        val reserved = Array(size) { BooleanArray(size) }

        fun put(x: Int, y: Int, dark: Boolean) {
            if (x < 0 || y < 0 || x >= size || y >= size) return
            base[y][x] = dark
            reserved[y][x] = true
        }

        for (i in 0 until size) {
            put(6, i, i % 2 == 0)
            put(i, 6, i % 2 == 0)
        }

        fun finder(cx: Int, cy: Int) {
            for (dy in -4..4) {
                for (dx in -4..4) {
                    val distance = maxOf(kotlin.math.abs(dx), kotlin.math.abs(dy))
                    put(cx + dx, cy + dy, distance != 2 && distance != 4)
                }
            }
        }
        finder(3, 3)
        finder(size - 4, 3)
        finder(3, size - 4)

        val centres = ALIGN[version]
        for (ay in centres.indices) {
            for (ax in centres.indices) {
                val overFinder = (ax == 0 && ay == 0) ||
                    (ax == 0 && ay == centres.size - 1) ||
                    (ax == centres.size - 1 && ay == 0)
                if (overFinder) continue
                for (dy in -2..2) {
                    for (dx in -2..2) {
                        val distance = maxOf(kotlin.math.abs(dx), kotlin.math.abs(dy))
                        put(centres[ax] + dx, centres[ay] + dy, distance != 1)
                    }
                }
            }
        }

        // Both format strips are claimed before the data pass, so the bits that
        // carry the mask cannot land on cells the mask describes.
        for (i in 0..8) {
            reserved[i][8] = true
            reserved[8][i] = true
        }
        for (i in 0 until 8) {
            reserved[8][size - 1 - i] = true
            reserved[size - 1 - i][8] = true
        }

        if (version >= 7) {
            val versionBits = (version shl 12) or remainder(version, 0x1F25, 12)
            for (i in 0 until 18) {
                val dark = ((versionBits ushr i) and 1) != 0
                put(size - 11 + i % 3, i / 3, dark)
                put(i / 3, size - 11 + i % 3, dark)
            }
        }

        var best: Array<BooleanArray>? = null
        var bestScore = Int.MAX_VALUE
        for (mask in 0..7) {
            val modules = Array(size) { base[it].copyOf() }
            val taken = Array(size) { reserved[it].copyOf() }
            placeData(modules, taken, codewords, mask)
            writeFormat(modules, size, mask)
            val score = penalty(modules)
            if (score < bestScore) {
                bestScore = score
                best = modules
            }
        }

        val chosen = best ?: error("no mask could be drawn")
        val flat = BooleanArray(size * size)
        for (y in 0 until size) {
            for (x in 0 until size) flat[y * size + x] = chosen[y][x]
        }
        return Code(size, flat)
    }

    private fun dataCodewords(version: Int): Int {
        val layout = ECC[version]
        var total = 0
        var group = 1
        while (group + 1 < layout.size) {
            total += layout[group] * layout[group + 1]
            group += 2
        }
        return total
    }

    private fun pickVersion(byteCount: Int): Int {
        for (version in 1 until ECC.size) {
            val capacity = dataCodewords(version) * 8
            val needed = 4 + (if (version <= 9) 8 else 16) + byteCount * 8
            if (needed <= capacity) return version
        }
        throw IllegalArgumentException("That link is too long to show as a code")
    }

    private fun placeData(
        modules: Array<BooleanArray>,
        reserved: Array<BooleanArray>,
        codewords: ByteArray,
        mask: Int,
    ) {
        val size = modules.size
        var bit = 0
        var right = size - 1
        while (right >= 1) {
            // The vertical timing pattern is not part of the data area.
            if (right == 6) right = 5
            for (vertical in 0 until size) {
                for (column in 0..1) {
                    val x = right - column
                    val upward = ((right + 1) and 2) == 0
                    val y = if (upward) size - 1 - vertical else vertical
                    if (!reserved[y][x]) {
                        val dark = if (bit < codewords.size * 8) {
                            ((codewords[bit ushr 3].toInt() ushr (7 - (bit and 7))) and 1) != 0
                        } else {
                            false
                        }
                        modules[y][x] = dark xor maskBit(mask, x, y)
                        bit++
                    }
                }
            }
            right -= 2
        }
    }

    private fun maskBit(mask: Int, x: Int, y: Int): Boolean = when (mask) {
        0 -> (x + y) % 2 == 0
        1 -> y % 2 == 0
        2 -> x % 3 == 0
        3 -> (x + y) % 3 == 0
        4 -> (x / 3 + y / 2) % 2 == 0
        5 -> x * y % 2 + x * y % 3 == 0
        6 -> (x * y % 2 + x * y % 3) % 2 == 0
        else -> ((x + y) % 2 + x * y % 3) % 2 == 0
    }

    /** Error-correction level M is 0b00, so the five data bits are the mask. */
    private fun writeFormat(modules: Array<BooleanArray>, size: Int, mask: Int) {
        val bits = ((mask shl 10) or remainder(mask, 0x537, 10)) xor 0x5412
        fun bit(i: Int) = ((bits ushr i) and 1) != 0
        for (i in 0..5) modules[i][8] = bit(i)
        modules[7][8] = bit(6)
        modules[8][8] = bit(7)
        modules[8][7] = bit(8)
        for (i in 9..14) modules[8][14 - i] = bit(i)
        for (i in 0..7) modules[8][size - 1 - i] = bit(i)
        for (i in 8..14) modules[size - 15 + i][8] = bit(i)
        // The one module that is always dark.
        modules[size - 8][8] = true
    }

    /** BCH remainder, as the format and version strips are checksummed. */
    private fun remainder(value: Int, divisor: Int, degree: Int): Int {
        var result = value shl degree
        for (bit in 31 downTo degree) {
            if (((result ushr bit) and 1) == 1) result = result xor (divisor shl (bit - degree))
        }
        return result and ((1 shl degree) - 1)
    }

    private fun reedSolomon(block: ByteArray, degree: Int): ByteArray {
        val divisor = IntArray(degree)
        divisor[degree - 1] = 1
        var root = 1
        for (i in 0 until degree) {
            for (j in 0 until degree) {
                divisor[j] = multiply(divisor[j], root)
                if (j + 1 < degree) divisor[j] = divisor[j] xor divisor[j + 1]
            }
            root = multiply(root, 2)
        }

        val result = IntArray(degree)
        for (byte in block) {
            val factor = (byte.toInt() and 0xFF) xor result[0]
            System.arraycopy(result, 1, result, 0, degree - 1)
            result[degree - 1] = 0
            for (i in 0 until degree) result[i] = result[i] xor multiply(divisor[i], factor)
        }
        return ByteArray(degree) { result[it].toByte() }
    }

    /** Multiplication in GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1. */
    private fun multiply(x: Int, y: Int): Int {
        var product = 0
        for (i in 7 downTo 0) {
            product = (product shl 1) xor ((product ushr 7) * 0x11D)
            product = product xor (((y ushr i) and 1) * x)
        }
        return product and 0xFF
    }

    private fun penalty(modules: Array<BooleanArray>): Int {
        val size = modules.size
        var score = 0

        fun at(across: Boolean, line: Int, position: Int): Boolean =
            if (across) modules[line][position] else modules[position][line]

        for (across in booleanArrayOf(true, false)) {
            for (line in 0 until size) {
                var run = 1
                var previous = at(across, line, 0)
                for (position in 1 until size) {
                    val current = at(across, line, position)
                    if (current == previous) {
                        run++
                    } else {
                        if (run >= 5) score += 3 + (run - 5)
                        previous = current
                        run = 1
                    }
                }
                if (run >= 5) score += 3 + (run - 5)
            }
        }

        for (y in 0 until size - 1) {
            for (x in 0 until size - 1) {
                val corner = modules[y][x]
                if (corner == modules[y][x + 1] &&
                    corner == modules[y + 1][x] &&
                    corner == modules[y + 1][x + 1]
                ) {
                    score += 3
                }
            }
        }

        val finderLike = booleanArrayOf(true, false, true, true, true, false, true)
        for (across in booleanArrayOf(true, false)) {
            for (line in 0 until size) {
                for (start in 0..size - 7) {
                    var matches = true
                    for (offset in 0 until 7) {
                        if (at(across, line, start + offset) != finderLike[offset]) {
                            matches = false
                            break
                        }
                    }
                    if (matches) score += 40
                }
            }
        }

        var dark = 0
        for (row in modules) for (cell in row) if (cell) dark++
        val percent = dark * 100 / (size * size)
        score += (kotlin.math.abs(percent - 50) / 5) * 10
        return score
    }

    private class BitBuffer {
        private val bytes = ArrayList<Byte>()
        var size = 0
            private set

        fun append(value: Int, length: Int) {
            for (i in length - 1 downTo 0) {
                val bit = (value ushr i) and 1
                if (size % 8 == 0) bytes.add(0)
                bytes[bytes.size - 1] =
                    (bytes.last().toInt() or (bit shl (7 - size % 8))).toByte()
                size++
            }
        }

        fun toBytes(): ByteArray = bytes.toByteArray()
    }
}
