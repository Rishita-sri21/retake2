import ctypes, sys
G = ctypes.RTLD_GLOBAL
for lib in ['libflite.so.1','libflite_usenglish.so.1','libflite_cmulex.so.1']: ctypes.CDLL(lib, mode=G)
flite = ctypes.CDLL('libflite.so.1', mode=G)
voice_lib = ctypes.CDLL('libflite_cmu_us_slt.so.1', mode=G)
flite.flite_init()
voice_lib.register_cmu_us_slt.restype = ctypes.c_void_p
v = voice_lib.register_cmu_us_slt(None)
flite.flite_text_to_speech.restype = ctypes.c_float
flite.flite_text_to_speech.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_char_p]
d = flite.flite_text_to_speech(sys.argv[1].encode(), v, sys.argv[2].encode())
print(round(d,3))
