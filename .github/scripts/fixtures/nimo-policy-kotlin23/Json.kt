package org.json
class JSONObject { companion object { @JvmField val NULL:Any=Any() }; fun put(k:String,v:Any?):JSONObject=this; fun put(k:String,v:Boolean):JSONObject=this; fun put(k:String,v:Long):JSONObject=this; fun put(k:String,v:Int):JSONObject=this; fun getLong(k:String):Long=0; fun getJSONObject(k:String):JSONObject=this }
