#ifndef __CONV_H__
#define __CONV_H__

#define LEN_MSG_COD 5
#define LEN_ACNT    (10 + 1)
#define LEN_FILLER  200
#define INIT_ST(x)  memset(&(x), 0x00, sizeof(x))
#define DB_SQLCODE  sqlca.sqlcode

typedef int  int32;
typedef long int64;

typedef struct
{
    char  szAcntNo[LEN_ACNT];
    char  acFiller[LEN_FILLER];
    int32 nCnt;
} ConvIn_t;

typedef struct conv_out
{
    char szMsg[20 + 1];
} ConvOut;

int32 Conv_Proc(ConvIn_t *ptIn, ConvOut *ptOut);

#endif
