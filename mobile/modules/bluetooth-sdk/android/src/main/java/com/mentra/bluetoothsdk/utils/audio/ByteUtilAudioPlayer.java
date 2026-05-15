package com.mentra.core.utils.audio;

import android.util.Log;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.ObjectInputStream;
import java.io.ObjectOutputStream;
import java.io.UnsupportedEncodingException;
import java.util.Calendar;

public class ByteUtilAudioPlayer {

	//"0123" -> byte{1,23}
    public static byte[] digitString2DigitByte(String str) {
    	if(str == null)
    		return null;
    	boolean bOdd = false;
    	int len = str.length();
    	if(len %2 == 1)
    	{
    		bOdd = true;
    		len ++;
    	}
    	byte [] bts = new byte[len/2];
    	if(bOdd)
    	{
    		bts[0] = (byte)(str.charAt(0) - '0');
    	}
    	int i = bOdd ? 1 : 0;
    	int n = 0;

    	for(;i < len ;i+=2)
    	{
    		n = (str.charAt(i) - '0') *10 + (str.charAt(i+1) - '0');
    		bts[(i+1)/2] = (byte)n;
    	}
    	return bts;
    }

	//"01230A" -> byte{0x01,0x23,0x0A}
    public static byte[] digitString2HexByte(String str2) {
    	if(str2 == null)
    		return null;
    	String str = str2.toUpperCase();
    	//String str = str2.toLowerCase();
    	boolean bOdd = false;
    	int len = str.length();
    	if(len %2 == 1)
    	{
    		bOdd = true;
    		len ++;
    	}
    	byte [] bts = new byte[len/2];
    	if(bOdd)
    	{
    		bts[0] = (byte)(str.charAt(0) - '0');
    	}
    	int i = bOdd ? 1 : 0;
    	int n = 0,low , high;

    	for(;i < len ;i+=2)
    	{
    		low = str.charAt(i+1);
    		high = str.charAt(i);
    		if(low >= 'A')
    		{
    			low = low - 'A' + 10;
    		}
    		else
    		{
    			low -= '0';
    		}

    		if(high >= 'A')
    		{
    			high = high - 'A' + 10;
    		}
    		else
    		{
    			high -= '0';
    		}
    		n = high *16 + low;
    		bts[(i+1)/2] = (byte)n;
    	}
    	return bts;
    }

    public static byte regByte(byte ss) {
    	return (ss < 0) ? (byte)(ss & 0xFF) :ss;
    }

    public static String bytetoHexString(byte ss) {
    	int is = (ss < 0) ? (ss &0xFF) :ss;
    	return String.format("%02x", is).toUpperCase();
    }

    public static String intToHexString(int num,int bit) {
    	//return Integer.toHexString(num).toUpperCase();
    	return String.format("%0"+bit+"x", num).toUpperCase();
    }

    public static String intToString(int num,int bit) {
    	//return Integer.toHexString(num).toUpperCase();
    	return String.format("%0"+bit+"d", num).toUpperCase();
    }

    public static int hexStringToint(String str) {
    	int num = 0;
    	String content = str.toUpperCase();
    	char [] chs = content.toCharArray();
    	for(int i = 0;i< content.length();i++)
    	{
    		num *= 16;
    		if(chs[i] >= '0' && chs[i] <= '9')
    			num += chs[i] - '0';
    		else
    			num += chs[i] -'A' + 10;
    	}
    	return num;
    }
    public static String outputHexString(byte [] flags, int startpos, int length)
    {
    	return getHexString_by_Bytes_dot(flags,startpos, length);
    }
    public static boolean string2Bytes(String str , byte[] dest, int destoffset)
    {
    	if(str == null || dest == null || str.length() < 1)
    	{
    		return false;
    	}

    	if(str.length() + destoffset >  dest.length)
    	{
    		Log.v("ByteUtilAudioPlayer","error string2Bytes src.length="+str.length()+",dest.length="+dest.length+",destoffset="+destoffset);
    		return false;
    	}

    	for(int i = 0; i < str.length(); i++)
    	{
    		dest[destoffset + i] = (byte)(str.charAt(i));
    	}

		return true;
    }


    public static byte[] String2bytes(String str,int len)
    {
		if(str == null || str.length() < len)
			return null;
		byte [] res = new byte[len];
		int n = 0;
		for(int i = 0; i < len ;i++)
		{
			res[i] = (byte)(str.charAt(i));
		}
		return res;
    }

    public static byte[] String2bytes(String str)
    {
		if(str == null || str.length() < 1)
			return null;
		return str.getBytes();
    }

    public static String bytes2String(byte [] bytes)
    {
    	if(bytes == null)
    		return null;
    	return new String(bytes);
    }

    public static String bytes2String(byte [] bytes, int offset, int len)
    {
    	if(bytes == null)
    		return null;
    	return new String(bytes,offset, len);
    }

    public static String bytes2String(byte [] bytes, int offset, int len,String encode)
    {
    	if(bytes == null)
    		return null;

		String body = null;
		try {
			body = new String(bytes,offset, len,encode);
			body = body.trim();
		} catch (UnsupportedEncodingException e) {
			e.printStackTrace();
		}
		return body;
    }

    public static boolean copyBytes(byte []src, int offset, int len , byte[] dest, int destoffset)
    {
		//BLog.v(CTConst.TAG,"copyBytes src="+src+",dest="+dest+",offset="+offset+",len="+len+",destoffset="+destoffset);
    	if(src == null || dest == null)
    	{
    		return false;
    	}

    	if(src.length < offset + len || dest.length < destoffset +len)
    	{
    		Log.v("ByteUtilAudioPlayer","error copyBytes src.length="+src.length+",dest.length="+dest.length);
    		return false;
    	}
    	for(int i = 0; i<len; i++)
    	{
    		dest[destoffset + i] = src[offset + i];
    	}
		return true;
    }

    public static boolean resetBytes(byte []data, int offset, int len)
    {
    	if(data == null || data.length < 1)
    	{
    		return false;
    	}

    	int end = (data.length <= offset + len) ? data.length : len;

    	for(int i = offset; i < end; i++)
    	{
    		data[i] = 0x0;
    	}

		return true;
    }
    public static boolean resetBytes(byte []data, int offset, int len,byte defaultValue)
    {
    	if(data == null || data.length < 1)
    	{
    		return false;
    	}

    	int end = (data.length <= offset + len) ? data.length : len;

    	for(int i = offset; i < end; i++)
    	{
    		data[i] = defaultValue;
    	}

		return true;
    }
    public static boolean compareBytes(byte []src, int offset, int len , byte[] dest, int destoffset,int destlen)
    {
		//BLog.v(CTConst.TAG,"copyBytes src="+src+",dest="+dest+",offset="+offset+",len="+len+",destoffset="+destoffset);
    	if(src == null || dest == null)
    	{
			Log.v("ByteUtilAudioPlayer","compareBytes error");
    		return false;
    	}
    	if(len != destlen)
    	{
    		Log.v("ByteUtilAudioPlayer","error compareBytes len="+len+",destlen="+destlen);
    		return false;
    	}
    	if(src.length < offset + len || dest.length < destoffset +destlen)
    	{
    		Log.v("ByteUtilAudioPlayer","error compareBytes src.length="+src.length+",dest.length="+dest.length);
    		return false;
    	}
    	for(int i = 0; i<len; i++)
    	{
			//Log.v("dest["+(destoffset + i)+"]="+ByteUtilAudioPlayer.bytetoHexString(dest[destoffset + i])+",src["+(offset + i)+"]="+ByteUtilAudioPlayer.bytetoHexString(src[offset + i]));
    		if(dest[destoffset + i] != src[offset + i])
    		{
    			return false;
    		}
    	}
		return true;
    }

	public static String byte2String_2Chars1Byte(byte[] buf, int offset, int len) {

		if (buf == null || buf.length < offset + len)
			return null;

		StringBuffer sb = new StringBuffer();
		int yu = 0;
		int shi = 0;
    	int n1 = 0;
		for (int i = 0; i < len; i++) {
			n1 = (buf[offset + i] < 0) ? (256+buf[offset + i]):buf[offset + i];
			yu = n1 % 10 + 0x30;
			shi = n1 /10;
			if(shi > 9)
			{
				shi = shi % 10;
			}
			shi += 0x30;

			sb.append((char)shi);
			sb.append((char)yu);
		}
		return sb.toString();
	}

	public static byte[] String2byte_2Chars1Byte(String str,int byteLen) {

		if(str == null || str.length() != byteLen * 2)
			return null;
		byte[] res = new byte[byteLen];
		for(int i = 0; i < byteLen; i++)
		{
			char c = str.charAt(i*2);
			char c2 = str.charAt(i*2+1);
			res[i] = (byte)((c - 0x30) *10 + (c2 - 0x30));
		}
		return res;
	}


	public static byte[] getBytes_by_HexString_dot2(String str,int byteLen) {

		if(str == null || str.length() != byteLen * 2)
			return null;
		byte[] res = new byte[byteLen];
		for(int i = 0; i < byteLen; i++)
		{
			char c = str.charAt(i*2);
			char c2 = str.charAt(i*2+1);
			int ac = c;
			int ac2 = c2;
			if(c >= 'A' && c <= 'F')
			{
				ac -= 'A' + 10;
			}
			else if(c >= 'a' && c <= 'f')
			{
				ac -= 'a' + 10;
			}
			else
			{
				ac -= 0x30;
			}

			if(c2 >= 'A' && c2 <= 'F')
			{
				ac2 -= 'A' + 10;
			}
			else if(c2 >= 'a' && c2 <= 'f')
			{
				ac2 -= 'a' + 10;
			}
			else
			{
				ac2 -= 0x30;
			}
			res[i] = (byte)(ac*16 +ac2);
		}
		return res;
	}

	public static byte[] getBytes_by_HexString_dot(String str) {
		if(str == null)
			return null;
		String [] sts = str.split(",");
		if(sts == null || sts.length < 1)
		{
			return null;
		}
		byte [] bts = new byte[sts.length];
		char c1, c2;
		int v1, v2;
		for(int i = 0;i < sts.length;i++)
		{
			if(sts[i].length() == 2)
			{
				c1 = sts[i].charAt(0);
				c2 = sts[i].charAt(1);
				v1 = c1;
				v2 = c2;
				if(c1 >= 'A' && c1 <= 'F')
				{
					v1 -= 'A' +10;
				}
				else
				{
					v1 -= 0x30;
				}

				if(c2 >= 'A' && c2 <= 'F')
				{
					v2 -= 'A' +10;
				}
				else
				{
					v2 -= 0x30;
				}
				bts[i] = (byte)(v1 *16 + v2);
			}
		}
		return bts;
	}
	public static String getHexString_by_Bytes_dot(byte[] bts)
	{
		if(bts == null)
		{
			return null;
		}
		StringBuffer sb = new StringBuffer();
		for(int i = 0;i< bts.length;i++)
		{
			sb.append(ByteUtilAudioPlayer.bytetoHexString(bts[i]));
			if(i != bts.length - 1)
				sb.append(",");
		}
		return sb.toString();
	}

	public static String getHexString_by_Bytes_dot(byte[] bts, int offset, int length)
	{
		if(bts == null)
		{
			return null;
		}
		int len = length > bts.length ? bts.length : length;
		StringBuffer sb = new StringBuffer();
		for(int i = 0;i< len;i++)
		{
			sb.append(ByteUtilAudioPlayer.bytetoHexString(bts[offset + i]));
			if(i != len - 1)
				sb.append(",");
		}
		return sb.toString();
	}

    public static void int2Bytes(int value, int toByteLen,byte[]dest,int offset) {
    	if(dest == null || offset + toByteLen > dest.length)
    		return;
    	int v = value;
    	for(int i = toByteLen - 1; i >= 0; i--)
    	{
    		dest[offset + i] = (byte)(v & 0xFF);
    		v = (v >> 8);
     	}
    }

    public static int bytes2Int(byte []src, int offset, int len)
    {
    	if(src == null || offset + len > src.length)
    	{
    		return 0;
    	}
    	int v = 0;
    	for(int i = offset ;i < offset + len; i++)
    	{
    		v = (v <<8);
    		v += (src[i] < 0) ? (256 + src[i]) : src[i];
    	}

    	return v;
    }

    public static int byte2Int(byte ss) {
    	int is = (ss < 0) ? (ss &0xFF) :ss;
    	return is;
    }

    public static int byte2Int(byte hightbyte,byte lowbyte)
    {
    	int n1 = (lowbyte < 0) ? (256+lowbyte):lowbyte;
    	int n2 = (hightbyte < 0) ? (256+hightbyte):hightbyte;
    	//Log.v(CTConst.TAG,"lowbyte="+n1);
    	//Log.v(CTConst.TAG,"highbyte="+n2);
    	return n1 +(n2 << 8);
    }

    public static byte[] long2Byte(long milltime)
    {
    	byte [] bys = new byte[8];
		long lnvalue = milltime;
		for (int i = 7; i >= 0; i--) {
			bys[i] = (byte) (lnvalue & 0xFF);
			lnvalue = lnvalue >> 8;
		}
		return bys;
    }

    public static int BCD_2_Decimal(byte ss)//param ss is hex
    {
    	int is = (ss < 0) ? (ss &0xFF) :ss;
    	return BCD_2_Decimal(is);
    }

    public static int BCD_2_Decimal(int ss) //param ss is hex,should return decimal
    {
    	return ss - (ss >> 4) *6;
    }

    public static int Decimal_2_BCD(byte ss)
    {
    	int is = (ss < 0) ? (ss &0xFF) :ss;
    	return Decimal_2_BCD(is);
    }

    public static int Decimal_2_BCD(int ss)// param ss is decimal, should return hex  ,ss should be less than 0xFF
    {
    	return (ss+(ss / 10)*6);
    }

    public static int DecimalBig_2_BCD(int ss)// param ss is decimal, should return hex
    {
    	int t = ss;
    	int h4 = ss % 1000000;
    	t = h4 *1000000;
    	int h3 = (ss - t) % 10000;
    	t += h3 * 10000;
    	int h2 = (ss - t) % 100;
    	t += h2 * 100;
    	int h1 = ss - t;
    	return (Decimal_2_BCD(h4) << 24) + (Decimal_2_BCD(h3) << 16) + (Decimal_2_BCD(h2) << 8) +  Decimal_2_BCD(h1);
    }

    public static String BCD_2_String(byte [] data, int offset, int len)
    {
    	if(data == null || data.length < offset + len)
    	{
    		return null;
    	}
    	StringBuffer sb = new StringBuffer();
    	int v = 0;
    	for(int i = offset;i < offset + len;i++)
    	{
    		v = BCD_2_Decimal(data[i]);
    		sb.append(intToString(v,2));
    	}
    	return sb.toString();
    }

    public static int BCD_2_Int(byte [] data, int offset, int len)
    {
    	if(data == null || data.length < offset + len)
    	{
    		return 0;
    	}
    	StringBuffer sb = new StringBuffer();
    	int v = 0;
    	for(int i = offset;i < offset + len;i++)
    	{
    		v = BCD_2_Decimal(data[i]);
    		sb.append(intToString(v,2));
    	}
    	return Integer.parseInt(sb.toString());
    }

    public static byte[] subBytes(byte [] data, int offset, int len)
    {
    	if(data == null || data.length < offset + len)
    	{
    		return null;
    	}
    	byte [] bs = new byte[len];
    	copyBytes(data, offset, len, bs, 0);
    	return bs;
    }

    public static String packBytes2String(byte [] flags, int startpos, int endpos)
    {
    	if(flags == null)
    		return null;
		StringBuffer sb =  new StringBuffer();
		int n = 0;
		for(int i = startpos; i < endpos; i++)
		{
			n = flags[i]<0?(256+flags[i]):flags[i];
			sb.append(n);
			if(i != endpos-1)
			{
				sb.append(",");
			}
		}
		return sb.toString();
    }

    public static byte[] decodeString2bytes(String msgflag,int bytelength)
    {
		byte [] res = new byte[bytelength];
		int n = 0;
		boolean bValidMsgFlag = false;
		if(msgflag != null && !msgflag.equals(""))
		{
			String [] flags = msgflag.split(",");
			if(flags != null && flags.length == bytelength)
			{
				bValidMsgFlag = true;
	    		for(int i=0;i<bytelength;i++)
	    		{
	    			res[i] = (byte)(Integer.parseInt(flags[i]));
	    		}
			}
		}
		if(bValidMsgFlag == false)
		{
			res = null;
		}
		return res;
    }
    public static long YYMMDDHHmmssStringToMills(String str) {
    	//Log.v(CTConst.TAG,"settime from server str="+str);
    	if(str == null || str.length() != 14)
    	{
    		return 0L;
    	}
    	String yearstr = str.substring(0,4);
    	String monthstr = str.substring(4,6);
    	String daystr = str.substring(6,8);
    	String hourstr = str.substring(8,10);
    	String minstr = str.substring(10,12);
    	String secondstr = str.substring(12,14);

    	Calendar c = Calendar.getInstance();
    	c.set(Calendar.YEAR, Integer.parseInt(yearstr));
    	c.set(Calendar.MONTH, Integer.parseInt(monthstr)-1);
    	c.set(Calendar.DAY_OF_MONTH, Integer.parseInt(daystr));
    	c.set(Calendar.HOUR_OF_DAY, Integer.parseInt(hourstr));
    	c.set(Calendar.MINUTE, Integer.parseInt(minstr));
    	c.set(Calendar.SECOND, Integer.parseInt(secondstr));
    	return c.getTimeInMillis();
    }

    public static byte[] objectToByte(Object obj) throws Exception {
        ObjectOutputStream oos = null;
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            oos = new ObjectOutputStream(bos);
            oos.writeObject(obj);
            oos.writeObject(null);//to skip read error
            return bos.toByteArray();
        } finally {
            if (oos != null)
            	oos.close();
        }
    }

    public static Object byteToObject(byte[] data) throws Exception {
        ObjectInputStream ois = null;
        try {
            ByteArrayInputStream bis = new ByteArrayInputStream(data);
            ois = new ObjectInputStream(bis);
            bis.close();
            return ois.readObject();
        } finally {
            if (ois != null)
            {
            	ois.close();
            }
        }
    }
}
