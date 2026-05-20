package com.mentra.bluetoothsdk

internal fun numberValue(
    values: Map<String, Any>,
    vararg keys: String,
): Int? =
    keys.firstNotNullOfOrNull { key ->
        (values[key] as? Number)?.toInt()
    }

internal fun stringValue(
    values: Map<String, Any>,
    vararg keys: String,
): String? =
    keys.firstNotNullOfOrNull { key ->
        values[key]?.let { it as? String }
    }

internal fun boolValue(
    values: Map<String, Any>,
    vararg keys: String,
): Boolean? =
    keys.firstNotNullOfOrNull { key ->
        values[key] as? Boolean
    }

internal fun longValue(
    values: Map<String, Any>,
    vararg keys: String,
): Long? =
    keys.firstNotNullOfOrNull { key ->
        (values[key] as? Number)?.toLong()
    }

internal fun hasAnyKey(
    values: Map<String, Any>,
    vararg keys: String,
): Boolean = keys.any(values::containsKey)

internal fun Map<*, *>.stringKeyedMap(): Map<String, Any> =
    entries.mapNotNull { (key, value) ->
        val stringKey = key as? String ?: return@mapNotNull null
        val anyValue = value ?: return@mapNotNull null
        stringKey to anyValue
    }.toMap()

internal fun stringListValue(
    values: Map<String, Any>,
    key: String,
): List<String> = (values[key] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()

internal fun mapListValue(
    values: Map<String, Any>,
    key: String,
): List<Map<String, Any>> =
    (values[key] as? List<*>)?.mapNotNull(::stringMapValue) ?: emptyList()

internal fun stringMapValue(value: Any?): Map<String, Any>? =
    (value as? Map<*, *>)?.entries?.mapNotNull { (key, mapValue) ->
        val stringKey = key as? String ?: return@mapNotNull null
        val nonNullValue = mapValue ?: return@mapNotNull null
        stringKey to nonNullValue
    }?.toMap()
